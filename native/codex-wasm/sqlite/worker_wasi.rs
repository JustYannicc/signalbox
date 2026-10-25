// Derived from SQLx 0.9.0 `sqlx-sqlite/src/connection/worker.rs`.
// See NOTICE for the upstream license and pinned archive checksum.

use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use futures_channel::oneshot;
use futures_intrusive::sync::{Mutex, MutexGuard};
use sqlx_core::sql_str::SqlStr;
use tracing::{span::Span, Instrument};

use sqlx_core::error::Error;
use sqlx_core::transaction::{
    begin_ansi_transaction_sql, commit_ansi_transaction_sql, rollback_ansi_transaction_sql,
};
use sqlx_core::Either;

use crate::connection::establish::EstablishParams;
use crate::connection::execute;
use crate::connection::ConnectionState;
use crate::{SqliteArguments, SqliteQueryResult, SqliteRow, SqliteStatement};

#[cfg(feature = "deserialize")]
use crate::connection::deserialize::{deserialize, serialize, SchemaName, SqliteOwnedBuf};

// WASI preview 1 has no worker threads. The FIFO command queue is unbounded so Drop can
// enqueue rollback without blocking; result rows stay bounded for backpressure. This means
// SqliteConnectOptions::command_buffer_size does not bound commands on this target.

pub(crate) struct ConnectionWorker {
    command_tx: flume::Sender<(Command, tracing::Span)>,
    /// Mutex for locking access to the database.
    pub(crate) shared: Arc<WorkerSharedState>,
}

pub(crate) struct WorkerSharedState {
    transaction_depth: AtomicUsize,
    cached_statements_size: AtomicUsize,
    pub(crate) conn: Mutex<ConnectionState>,
}

impl WorkerSharedState {
    pub(crate) fn get_transaction_depth(&self) -> usize {
        self.transaction_depth.load(Ordering::Acquire)
    }

    pub(crate) fn get_cached_statements_size(&self) -> usize {
        self.cached_statements_size.load(Ordering::Acquire)
    }
}

enum Command {
    Prepare {
        query: SqlStr,
        tx: oneshot::Sender<Result<SqliteStatement, Error>>,
    },
    #[cfg(feature = "offline")]
    Describe {
        query: SqlStr,
        tx: oneshot::Sender<Result<sqlx_core::describe::Describe<crate::Sqlite>, Error>>,
    },
    Execute {
        query: SqlStr,
        arguments: Option<SqliteArguments>,
        persistent: bool,
        tx: flume::Sender<Result<Either<SqliteQueryResult, SqliteRow>, Error>>,
        limit: Option<usize>,
    },
    #[cfg(feature = "deserialize")]
    Serialize {
        schema: Option<SchemaName>,
        tx: oneshot::Sender<Result<SqliteOwnedBuf, Error>>,
    },
    #[cfg(feature = "deserialize")]
    Deserialize {
        schema: Option<SchemaName>,
        data: SqliteOwnedBuf,
        read_only: bool,
        tx: oneshot::Sender<Result<(), Error>>,
    },
    Begin {
        tx: rendezvous_oneshot::Sender<Result<(), Error>>,
        statement: Option<SqlStr>,
    },
    Commit {
        tx: rendezvous_oneshot::Sender<Result<(), Error>>,
    },
    Rollback {
        tx: Option<rendezvous_oneshot::Sender<Result<(), Error>>>,
    },
    UnlockDb,
    ClearCache {
        tx: oneshot::Sender<()>,
    },
    Ping {
        tx: oneshot::Sender<()>,
    },
    Shutdown {
        tx: oneshot::Sender<()>,
    },
}

enum WorkerControl {
    Continue,
    Stop,
    Shutdown(oneshot::Sender<()>),
}

async fn worker_loop(
    params: EstablishParams,
    command_tx: flume::Sender<(Command, Span)>,
    command_rx: flume::Receiver<(Command, Span)>,
    establish_tx: oneshot::Sender<Result<ConnectionWorker, Error>>,
) {
    let conn = match params.establish() {
        Ok(conn) => conn,
        Err(error) => {
            let _ = establish_tx.send(Err(error));
            return;
        }
    };

    let shared = Arc::new(WorkerSharedState {
        transaction_depth: AtomicUsize::new(0),
        cached_statements_size: AtomicUsize::new(0),
        // UnlockDb must let an already waiting user take the fair mutex first.
        conn: Mutex::new(conn, true),
    });
    let mut conn = Some(shared.conn.try_lock().unwrap());

    if establish_tx
        .send(Ok(ConnectionWorker {
            command_tx,
            shared: Arc::clone(&shared),
        }))
        .is_err()
    {
        return;
    }

    let mut ignore_next_start_rollback = false;
    loop {
        let Ok((command, span)) = command_rx.recv_async().await else {
            break;
        };

        let control = process_command(
            command,
            &mut conn,
            &shared,
            &mut ignore_next_start_rollback,
        )
        .instrument(span)
        .await;

        match control {
            WorkerControl::Continue => {}
            WorkerControl::Stop => break,
            WorkerControl::Shutdown(tx) => {
                drop(conn);
                drop(shared);
                let _ = tx.send(());
                return;
            }
        }
    }
}

async fn process_command<'a>(
    command: Command,
    conn: &mut Option<MutexGuard<'a, ConnectionState>>,
    shared: &'a WorkerSharedState,
    ignore_next_start_rollback: &mut bool,
) -> WorkerControl {
    match command {
        Command::Prepare { query, tx } => {
            let conn = conn.as_mut().expect("worker owns the database lock");
            let result = prepare(conn, query);
            let _ = tx.send(result);

            // This can issue an unnecessary write on failure, as in the native worker.
            update_cached_statements_size(
                conn,
                &shared.cached_statements_size,
            );
        }
        #[cfg(feature = "offline")]
        Command::Describe { query, tx } => {
            let conn = conn.as_mut().expect("worker owns the database lock");
            let _ = tx.send(crate::connection::describe::describe(conn, query));
        }
        Command::Execute {
            query,
            arguments,
            persistent,
            tx,
            limit,
        } => {
            let conn = conn.as_mut().expect("worker owns the database lock");
            let iter = match execute::iter(conn, query, arguments, persistent) {
                Ok(iter) => iter,
                Err(error) => {
                    let _ = tx.send_async(Err(error)).await;
                    return WorkerControl::Continue;
                }
            };

            match limit {
                None => {
                    for result in iter {
                        let has_error = result.is_err();
                        if tx.send_async(result).await.is_err() || has_error {
                            break;
                        }
                    }
                }
                Some(limit) => {
                    let mut iter = iter;
                    let mut rows_returned = 0;

                    while let Some(result) = iter.next() {
                        if let Ok(ok) = &result {
                            if ok.is_right() {
                                rows_returned += 1;
                                if rows_returned >= limit {
                                    drop(iter);
                                    let _ = tx.send_async(result).await;
                                    break;
                                }
                            }
                        }
                        let has_error = result.is_err();
                        if tx.send_async(result).await.is_err() || has_error {
                            break;
                        }
                    }
                }
            }

            update_cached_statements_size(
                conn,
                &shared.cached_statements_size,
            );
        }
        Command::Begin { tx, statement } => {
            let conn = conn.as_mut().expect("worker owns the database lock");
            let depth = shared.transaction_depth.load(Ordering::Acquire);
            let is_custom_statement = statement.is_some();
            let statement = match statement {
                // Custom BEGIN statements are not allowed inside a transaction.
                Some(_) if depth > 0 => {
                    if tx.send(Err(Error::InvalidSavePointStatement)).await.is_err() {
                        return WorkerControl::Stop;
                    }
                    return WorkerControl::Continue;
                }
                Some(statement) => statement,
                None => begin_ansi_transaction_sql(depth),
            };
            let result = conn
                .handle
                .exec(statement.as_str())
                .and_then(|result| {
                    if is_custom_statement && !conn.handle.in_transaction() {
                        return Err(Error::BeginFailed);
                    }

                    shared.transaction_depth.fetch_add(1, Ordering::Release);
                    Ok(result)
                });
            let result_ok = result.is_ok();

            if tx.send(result).await.is_err() && result_ok {
                // The cancelled BEGIN has no Transaction value to clean it up.
                if let Err(error) = conn
                    .handle
                    .exec(rollback_ansi_transaction_sql(depth + 1).as_str())
                    .map(|_| {
                        shared.transaction_depth.fetch_sub(1, Ordering::Release);
                    })
                {
                    tracing::error!(%error, "failed to rollback cancelled transaction");
                    return WorkerControl::Stop;
                }
            }
        }
        Command::Commit { tx } => {
            let conn = conn.as_mut().expect("worker owns the database lock");
            let depth = shared.transaction_depth.load(Ordering::Acquire);
            let result = if depth > 0 {
                conn.handle
                    .exec(commit_ansi_transaction_sql(depth).as_str())
                    .map(|_| {
                        shared.transaction_depth.fetch_sub(1, Ordering::Release);
                    })
            } else {
                Ok(())
            };
            let result_ok = result.is_ok();

            if tx.send(result).await.is_err() && result_ok {
                // The dropped Transaction will attempt a rollback after its COMMIT.
                *ignore_next_start_rollback = true;
            }
        }
        Command::Rollback { tx } => {
            if *ignore_next_start_rollback && tx.is_none() {
                *ignore_next_start_rollback = false;
                return WorkerControl::Continue;
            }

            let conn = conn.as_mut().expect("worker owns the database lock");
            let depth = shared.transaction_depth.load(Ordering::Acquire);
            let result = if depth > 0 {
                conn.handle
                    .exec(rollback_ansi_transaction_sql(depth).as_str())
                    .map(|_| {
                        shared.transaction_depth.fetch_sub(1, Ordering::Release);
                    })
            } else {
                Ok(())
            };
            let result_ok = result.is_ok();

            if let Some(tx) = tx {
                if tx.send(result).await.is_err() && result_ok {
                    *ignore_next_start_rollback = true;
                }
            }
        }
        #[cfg(feature = "deserialize")]
        Command::Serialize { schema, tx } => {
            let conn = conn.as_mut().expect("worker owns the database lock");
            let _ = tx.send(serialize(conn, schema));
        }
        #[cfg(feature = "deserialize")]
        Command::Deserialize {
            schema,
            data,
            read_only,
            tx,
        } => {
            let conn = conn.as_mut().expect("worker owns the database lock");
            let _ = tx.send(deserialize(conn, schema, data, read_only));
        }
        Command::ClearCache { tx } => {
            let conn = conn.as_mut().expect("worker owns the database lock");
            conn.statements.clear();
            update_cached_statements_size(conn, &shared.cached_statements_size);
            let _ = tx.send(());
        }
        Command::UnlockDb => {
            drop(conn.take().expect("worker owns the database lock"));
            *conn = Some(shared.conn.lock().await);
        }
        Command::Ping { tx } => {
            let _ = tx.send(());
        }
        Command::Shutdown { tx } => {
            drop(conn.take());
            return WorkerControl::Shutdown(tx);
        }
    }

    WorkerControl::Continue
}

impl ConnectionWorker {
    pub(crate) async fn establish(params: EstablishParams) -> Result<Self, Error> {
        // `command_buffer_size` cannot bound the Drop rollback path without blocking the
        // current-thread executor. Keep the queue FIFO and let `row_buffer_size` bound rows.
        let (command_tx, command_rx) = flume::unbounded();
        let (establish_tx, establish_rx) = oneshot::channel();
        let worker_tx = command_tx.clone();

        tokio::spawn(async move {
            worker_loop(
                params,
                worker_tx,
                command_rx,
                establish_tx,
            )
            .await;
        });

        establish_rx.await.map_err(|_| Error::WorkerCrashed)?
    }

    pub(crate) async fn prepare(&mut self, query: SqlStr) -> Result<SqliteStatement, Error> {
        self.oneshot_cmd(|tx| Command::Prepare { query, tx })
            .await?
    }

    #[cfg(feature = "offline")]
    pub(crate) async fn describe(
        &mut self,
        query: SqlStr,
    ) -> Result<sqlx_core::describe::Describe<crate::Sqlite>, Error> {
        self.oneshot_cmd(|tx| Command::Describe { query, tx })
            .await?
    }

    pub(crate) async fn execute(
        &mut self,
        query: SqlStr,
        args: Option<SqliteArguments>,
        chan_size: usize,
        persistent: bool,
        limit: Option<usize>,
    ) -> Result<flume::Receiver<Result<Either<SqliteQueryResult, SqliteRow>, Error>>, Error> {
        let (tx, rx) = flume::bounded(chan_size);

        self.send_command_async(
            Command::Execute {
                query,
                arguments: args,
                persistent,
                tx,
                limit,
            },
            Span::current(),
        )
        .await?;

        Ok(rx)
    }

    pub(crate) async fn begin(&mut self, statement: Option<SqlStr>) -> Result<(), Error> {
        self.oneshot_cmd_with_ack(|tx| Command::Begin { tx, statement })
            .await?
    }

    pub(crate) async fn commit(&mut self) -> Result<(), Error> {
        self.oneshot_cmd_with_ack(|tx| Command::Commit { tx })
            .await?
    }

    pub(crate) async fn rollback(&mut self) -> Result<(), Error> {
        self.oneshot_cmd_with_ack(|tx| Command::Rollback { tx: Some(tx) })
            .await?
    }

    pub(crate) fn start_rollback(&mut self) -> Result<(), Error> {
        self.command_tx
            .send((Command::Rollback { tx: None }, Span::current()))
            .map_err(|_| Error::WorkerCrashed)
    }

    pub(crate) async fn ping(&mut self) -> Result<(), Error> {
        self.oneshot_cmd(|tx| Command::Ping { tx }).await
    }

    #[cfg(feature = "deserialize")]
    pub(crate) async fn deserialize(
        &mut self,
        schema: Option<SchemaName>,
        data: SqliteOwnedBuf,
        read_only: bool,
    ) -> Result<(), Error> {
        self.oneshot_cmd(|tx| Command::Deserialize {
            schema,
            data,
            read_only,
            tx,
        })
        .await?
    }

    #[cfg(feature = "deserialize")]
    pub(crate) async fn serialize(
        &mut self,
        schema: Option<SchemaName>,
    ) -> Result<SqliteOwnedBuf, Error> {
        self.oneshot_cmd(|tx| Command::Serialize { schema, tx })
            .await?
    }

    async fn oneshot_cmd<F, T>(&mut self, command: F) -> Result<T, Error>
    where
        F: FnOnce(oneshot::Sender<T>) -> Command,
    {
        let (tx, rx) = oneshot::channel();

        self.send_command_async(command(tx), Span::current()).await?;

        rx.await.map_err(|_| Error::WorkerCrashed)
    }

    async fn oneshot_cmd_with_ack<F, T>(&mut self, command: F) -> Result<T, Error>
    where
        F: FnOnce(rendezvous_oneshot::Sender<T>) -> Command,
    {
        let (tx, rx) = rendezvous_oneshot::channel();

        self.send_command_async(command(tx), Span::current()).await?;

        rx.recv().await.map_err(|_| Error::WorkerCrashed)
    }

    pub(crate) async fn clear_cache(&mut self) -> Result<(), Error> {
        self.oneshot_cmd(|tx| Command::ClearCache { tx }).await
    }

    async fn send_command_async(&self, command: Command, span: Span) -> Result<(), Error> {
        self.command_tx
            .send_async((command, span))
            .await
            .map_err(|_| Error::WorkerCrashed)
    }

    pub(crate) async fn unlock_db(&mut self) -> Result<MutexGuard<'_, ConnectionState>, Error> {
        let (guard, res) = futures_util::future::join(
            // we need to join the wait queue for the lock before we send the message
            self.shared.conn.lock(),
            self.send_command_async(Command::UnlockDb, Span::current()),
        )
        .await;

        res?;

        Ok(guard)
    }

    /// Send a command to the worker to shut down the processing thread.
    ///
    /// A `WorkerCrashed` error may be returned if the thread has already stopped.
    pub(crate) fn shutdown(&mut self) -> impl Future<Output = Result<(), Error>> {
        let (tx, rx) = oneshot::channel();
        let command_tx = self.command_tx.clone();
        let span = Span::current();

        async move {
            command_tx
                .send_async((Command::Shutdown { tx }, span))
                .await
                .map_err(|_| Error::WorkerCrashed)?;

            // wait for the response
            rx.await.map_err(|_| Error::WorkerCrashed)
        }
    }
}

fn prepare(conn: &mut ConnectionState, query: SqlStr) -> Result<SqliteStatement, Error> {
    // prepare statement object (or checkout from cache)
    let statement = conn.statements.get(query.as_str(), true)?;

    let mut parameters = 0;
    let mut columns = None;
    let mut column_names = None;

    while let Some(statement) = statement.prepare_next(&mut conn.handle)? {
        parameters += statement.handle.bind_parameter_count();

        // the first non-empty statement is chosen as the statement we pull columns from
        if !statement.columns.is_empty() && columns.is_none() {
            columns = Some(Arc::clone(statement.columns));
            column_names = Some(Arc::clone(statement.column_names));
        }
    }

    Ok(SqliteStatement {
        sql: query,
        columns: columns.unwrap_or_default(),
        column_names: column_names.unwrap_or_default(),
        parameters,
    })
}

fn update_cached_statements_size(conn: &ConnectionState, size: &AtomicUsize) {
    size.store(conn.statements.len(), Ordering::Release);
}

// A oneshot channel where send completes only after the receiver receives the value.
mod rendezvous_oneshot {
    use super::oneshot::{self, Canceled};

    pub fn channel<T>() -> (Sender<T>, Receiver<T>) {
        let (inner_tx, inner_rx) = oneshot::channel();
        (Sender { inner: inner_tx }, Receiver { inner: inner_rx })
    }

    pub struct Sender<T> {
        inner: oneshot::Sender<(T, oneshot::Sender<()>)>,
    }

    impl<T> Sender<T> {
        pub async fn send(self, value: T) -> Result<(), Canceled> {
            let (ack_tx, ack_rx) = oneshot::channel();
            self.inner.send((value, ack_tx)).map_err(|_| Canceled)?;
            ack_rx.await
        }

    }

    pub struct Receiver<T> {
        inner: oneshot::Receiver<(T, oneshot::Sender<()>)>,
    }

    impl<T> Receiver<T> {
        pub async fn recv(self) -> Result<T, Canceled> {
            let (value, ack_tx) = self.inner.await?;
            ack_tx.send(()).map_err(|_| Canceled)?;
            Ok(value)
        }
    }
}

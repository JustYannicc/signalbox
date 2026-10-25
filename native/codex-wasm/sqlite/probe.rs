use std::error::Error;
use std::path::PathBuf;

use futures_util::TryStreamExt;
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection};
use sqlx::{Connection, Executor, Row};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn Error>> {
    let path = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("sqlite-worker-proof.sqlite"));
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .command_buffer_size(1)
        .row_buffer_size(1);

    let mut connection = SqliteConnection::connect_with(&options).await?;
    sqlx::query("PRAGMA auto_vacuum = INCREMENTAL")
        .execute(&mut connection)
        .await?;
    let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode = WAL")
        .fetch_one(&mut connection)
        .await?;
    assert_eq!(journal_mode, "delete");
    sqlx::query("CREATE TABLE IF NOT EXISTS proof_runs (ordinal INTEGER PRIMARY KEY)")
        .execute(&mut connection)
        .await?;
    let previous_invocations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM proof_runs")
        .fetch_one(&mut connection)
        .await?;
    sqlx::query("INSERT INTO proof_runs (ordinal) VALUES (?)")
        .bind(previous_invocations + 1)
        .execute(&mut connection)
        .await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS worker_probe (marker TEXT PRIMARY KEY)")
        .execute(&mut connection)
        .await?;
    sqlx::query("DELETE FROM worker_probe")
        .execute(&mut connection)
        .await?;
    sqlx::query("INSERT INTO worker_probe (marker) VALUES ('autocommit')")
        .execute(&mut connection)
        .await?;

    let mut committed = connection.begin().await?;
    sqlx::query("INSERT INTO worker_probe (marker) VALUES ('committed')")
        .execute(&mut *committed)
        .await?;
    committed.commit().await?;

    let mut rolled_back = connection.begin().await?;
    sqlx::query("INSERT INTO worker_probe (marker) VALUES ('explicit-rollback')")
        .execute(&mut *rolled_back)
        .await?;
    rolled_back.rollback().await?;

    let mut cancelled = connection.begin().await?;
    sqlx::query("INSERT INTO worker_probe (marker) VALUES ('drop-rollback')")
        .execute(&mut *cancelled)
        .await?;
    drop(cancelled);

    let mut rows = sqlx::query(
        "WITH RECURSIVE n(value) AS (
            VALUES(1)
            UNION ALL
            SELECT value + 1 FROM n WHERE value < 32
        )
        SELECT value FROM n",
    )
    .fetch(&mut connection);
    let first = rows.try_next().await?.ok_or("recursive query returned no rows")?;
    assert_eq!(first.try_get::<i64, _>(0)?, 1);
    drop(rows);

    let retained_before_close: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM worker_probe WHERE marker IN ('autocommit', 'committed')",
    )
    .fetch_one(&mut connection)
    .await?;
    let rolled_back_before_close: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM worker_probe WHERE marker IN ('explicit-rollback', 'drop-rollback')",
    )
    .fetch_one(&mut connection)
    .await?;
    assert_eq!(retained_before_close, 2);
    assert_eq!(rolled_back_before_close, 0);
    connection.close().await?;

    let mut reopened = SqliteConnection::connect_with(&options).await?;
    let retained_after_reopen: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM worker_probe WHERE marker IN ('autocommit', 'committed')",
    )
    .fetch_one(&mut reopened)
    .await?;
    let rolled_back_after_reopen: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM worker_probe WHERE marker IN ('explicit-rollback', 'drop-rollback')",
    )
    .fetch_one(&mut reopened)
    .await?;
    assert_eq!(retained_after_reopen, 2);
    assert_eq!(rolled_back_after_reopen, 0);
    let integrity: String = sqlx::query_scalar("PRAGMA quick_check")
        .fetch_one(&mut reopened)
        .await?;
    assert_eq!(integrity, "ok");
    let invocations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM proof_runs")
        .fetch_one(&mut reopened)
        .await?;
    assert_eq!(invocations, previous_invocations + 1);
    reopened.close().await?;

    println!(
        "SQLITE_WORKER_PROBE_OK path={} retained={} rollback=0 drop_rollback=0 stream_cancelled=1 reopened=1 command_buffer_size_ignored=1 row_buffer_size=1 journal_mode={} quick_check=ok previous_invocations={} invocations={}",
        path.display(),
        retained_after_reopen,
        journal_mode,
        previous_invocations,
        invocations,
    );
    Ok(())
}

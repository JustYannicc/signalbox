//! WASI searches share the current Tokio thread with cancellation and RPCs.

use super::*;
use nucleo::Utf32Str;
use nucleo::pattern::Pattern;

const BATCH_SIZE: usize = 256;

struct Candidate {
    file: FileMatch,
    length: usize,
    ordinal: usize,
}

fn retain_best(matches: &mut Vec<Candidate>, limit: usize) {
    // Nucleo applies these tie-breakers before the result limit, not lexical order.
    matches.sort_by(|a, b| b.file.score.cmp(&a.file.score)
        .then_with(|| a.length.cmp(&b.length))
        .then_with(|| a.ordinal.cmp(&b.ordinal)));
    matches.truncate(limit);
}

fn snapshot(
    inner: &SessionInner,
    query: &str,
    pattern: &Pattern,
    matches: &mut Vec<Candidate>,
    total_match_count: usize,
    scanned_file_count: usize,
    walk_complete: bool,
) -> FileSearchSnapshot {
    retain_best(matches, inner.limit);
    let mut files: Vec<_> = matches.iter().map(|item| item.file.clone()).collect();
    if inner.compute_indices {
        let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
        let mut buffer = Vec::new();
        for item in &mut files {
            let mut indices = Vec::new();
            let path = item.path.to_string_lossy();
            let _ = pattern.indices(Utf32Str::new(&path, &mut buffer), &mut matcher, &mut indices);
            indices.sort_unstable();
            indices.dedup();
            item.indices = Some(indices);
        }
    }
    FileSearchSnapshot {
        query: query.to_string(), matches: files,
        total_match_count, scanned_file_count, walk_complete,
    }
}

pub(super) async fn search(inner: Arc<SessionInner>, query: String, generation: u64) -> FileSearchSnapshot {
    let mut builder = WalkBuilder::new(&inner.search_directories[0]);
    for root in inner.search_directories.iter().skip(1) {
        builder.add(root);
    }
    builder.hidden(false).follow_links(true).require_git(true);
    if !inner.respect_gitignore {
        builder.git_ignore(false).git_global(false).git_exclude(false)
            .ignore(false).parents(false);
    }
    if let Some(overrides) = &inner.override_matcher {
        builder.overrides(overrides.clone());
    }
    let pattern = Pattern::parse(&query, CaseMatching::Ignore, Normalization::Smart);
    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let mut buffer = Vec::new();
    let mut matches = Vec::new();
    let mut reported = Vec::new();
    let mut total_match_count = 0;
    let mut scanned_file_count = 0;
    let mut walk_complete = true;
    for (ordinal, entry) in builder.build().enumerate() {
        if ordinal > 0 && ordinal % BATCH_SIZE == 0 {
            let partial = snapshot(&inner, &query, &pattern, &mut matches,
                total_match_count, scanned_file_count, false);
            if partial.matches != reported {
                reported = partial.matches.clone();
                inner.reporter.on_update(&partial);
            }
            tokio::task::yield_now().await;
        }
        if inner.cancelled.load(Ordering::Relaxed) || inner.shutdown.load(Ordering::Relaxed)
            || inner.generation.load(Ordering::Relaxed) != generation {
            walk_complete = false;
            break;
        }
        // Match the native walker: unreadable entries and non-UTF8 paths are skipped.
        let Ok(entry) = entry else { continue };
        let Some((root, relative)) = get_file_path(entry.path(), &inner.search_directories)
            else { continue };
        scanned_file_count += 1;
        let haystack = Utf32Str::new(relative, &mut buffer);
        let length = haystack.len();
        let Some(score) = pattern.score(haystack, &mut matcher) else { continue };
        total_match_count += 1;
        matches.push(Candidate {
            file: FileMatch {
                score, path: PathBuf::from(relative),
                match_type: match entry.file_type() {
                    Some(kind) if kind.is_dir() => MatchType::Directory,
                    _ => MatchType::File,
                },
                root: inner.search_directories[root].clone(), indices: None,
            },
            length, ordinal,
        });
        if matches.len() > inner.limit.saturating_mul(2) {
            retain_best(&mut matches, inner.limit);
        }
    }
    snapshot(&inner, &query, &pattern, &mut matches,
        total_match_count, scanned_file_count, walk_complete)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(path: String, ordinal: usize) -> Candidate {
        Candidate { length: path.chars().count(), ordinal,
            file: FileMatch { score: 80, path: path.into(), root: "/work".into(),
                match_type: MatchType::File, indices: None } }
    }

    #[test]
    fn limit_keeps_shorter_paths_before_lexical_ties() {
        let mut matches: Vec<_> = (0..50)
            .map(|i| candidate(format!("a-long-path-{i:02}.txt"), i)).collect();
        matches.push(candidate("z.txt".to_string(), 50));
        retain_best(&mut matches, 50);
        assert_eq!(matches.len(), 50);
        assert_eq!(matches[0].file.path, PathBuf::from("z.txt"));
        assert!(!matches.iter().any(|item| item.ordinal == 49));
    }

    #[test]
    fn equal_length_ties_keep_insertion_order_before_cutoff() {
        let mut matches = vec![candidate("z.txt".to_string(), 0), candidate("a.txt".to_string(), 1)];
        retain_best(&mut matches, 1);
        assert_eq!(matches[0].file.path, PathBuf::from("z.txt"));
    }

    struct Progress(tokio::sync::Notify);
    impl SessionReporter for Progress {
        fn on_update(&self, snapshot: &FileSearchSnapshot) {
            if !snapshot.walk_complete { self.0.notify_one(); }
        }
        fn on_complete(&self) {}
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancellation_runs_between_batches_before_the_walk_finishes() {
        let directory = tempfile::tempdir().unwrap();
        let entries = BATCH_SIZE * 8;
        for i in 0..entries { std::fs::write(directory.path().join(format!("entry-{i:04}")), "").unwrap(); }
        let reporter = Arc::new(Progress(tokio::sync::Notify::new()));
        let cancelled = Arc::new(AtomicBool::new(false));
        let inner = Arc::new(SessionInner {
            search_directories: vec![directory.path().to_path_buf()],
            override_matcher: None, generation: std::sync::atomic::AtomicU64::new(0),
            limit: 50, threads: 1, compute_indices: false, respect_gitignore: false,
            cancelled: cancelled.clone(), shutdown: Arc::new(AtomicBool::new(false)),
            reporter: reporter.clone(), work_tx: unbounded().0,
        });
        let control = tokio::spawn(async move {
            reporter.0.notified().await;
            cancelled.store(true, Ordering::Relaxed);
        });
        let result = tokio::spawn(search(inner, String::new(), 0)).await.unwrap();
        control.await.unwrap();
        assert!(!result.walk_complete);
        assert!(result.scanned_file_count > 0);
        assert!((result.scanned_file_count as usize) < entries);
    }
}

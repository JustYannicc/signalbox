//! WASI preview1 cannot spawn matcher, walker or Rayon threads.

use super::*;
use nucleo::Utf32Str;
use nucleo::pattern::Pattern;

pub(super) fn search(inner: &SessionInner, query: &str) -> FileSearchSnapshot {
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
    let pattern = Pattern::parse(query, CaseMatching::Ignore, Normalization::Smart);
    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let mut buffer = Vec::new();
    let mut matches = Vec::new();
    let mut total_match_count = 0;
    let mut scanned_file_count = 0;
    let mut walk_complete = true;
    let sort = |matches: &mut Vec<FileMatch>| {
        matches.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
        matches.truncate(inner.limit);
    };
    for entry in builder.build() {
        if inner.cancelled.load(Ordering::Relaxed) || inner.shutdown.load(Ordering::Relaxed) {
            walk_complete = false;
            break;
        }
        // Match the native walker: unreadable entries and non-UTF8 paths are skipped.
        let Ok(entry) = entry else { continue };
        let Some((root, relative)) = get_file_path(entry.path(), &inner.search_directories)
            else { continue };
        scanned_file_count += 1;
        let Some(score) = pattern.score(Utf32Str::new(relative, &mut buffer), &mut matcher)
            else { continue };
        total_match_count += 1;
        matches.push(FileMatch {
            score,
            path: PathBuf::from(relative),
            match_type: match entry.file_type() {
                Some(kind) if kind.is_dir() => MatchType::Directory,
                _ => MatchType::File,
            },
            root: inner.search_directories[root].clone(),
            indices: None,
        });
        if matches.len() > inner.limit.saturating_mul(2) {
            sort(&mut matches);
        }
    }
    sort(&mut matches);
    if inner.compute_indices {
        for item in &mut matches {
            let mut indices = Vec::new();
            let path = item.path.to_string_lossy();
            let _ = pattern.indices(Utf32Str::new(&path, &mut buffer), &mut matcher, &mut indices);
            indices.sort_unstable();
            indices.dedup();
            item.indices = Some(indices);
        }
    }
    FileSearchSnapshot {
        query: query.to_string(), matches, total_match_count, scanned_file_count, walk_complete,
    }
}

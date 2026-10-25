pub fn join_workers<'scope, T>(workers: Vec<std::thread::ScopedJoinHandle<'scope, T>>) -> Vec<T> {
    workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect()
}

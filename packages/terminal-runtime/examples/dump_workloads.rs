//! Writes the four shared byte fixtures of the benchmarks (`tests/support`) to a directory, so
//! another VT implementation can be fed the same bytes: `cargo run --release --example
//! dump_workloads -- <dir>`. One file per workload, named by its slug.

#[path = "../tests/support/mod.rs"]
mod support;

fn main() {
    let dir = std::env::args()
        .nth(1)
        .expect("usage: dump_workloads <dir>");
    std::fs::create_dir_all(&dir).expect("create the output directory");
    for (name, data) in support::workloads() {
        let slug: String = name
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() {
                    c.to_ascii_lowercase()
                } else {
                    '-'
                }
            })
            .collect();
        std::fs::write(format!("{dir}/{slug}.bin"), data).expect("write the fixture");
    }
}

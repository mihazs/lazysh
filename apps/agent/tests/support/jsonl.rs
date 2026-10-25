use serde_json::Value;
use std::{fs::File, io::Write, path::Path};
pub fn write(path: &Path, records: &[Value]) {
    let mut file = File::create(path).unwrap();
    for record in records {
        serde_json::to_writer(&mut file, record).unwrap();
        writeln!(file).unwrap();
    }
}

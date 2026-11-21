//! The History lines setting counts lines, libghostty-vt budgets bytes: `scrollback_bytes_for_lines`
//! must keep the requested rows of ordinary output at every width, and the budget must still bound
//! the history (it is not an invitation to keep everything).
mod support;

use lazysh_terminal_runtime::scrollback_bytes_for_lines;
use support::*;

#[test]
fn the_lines_budget_keeps_the_requested_rows_of_ordinary_output_and_bounds_the_history() {
    for (name, workload) in [
        ("plain", plain_rows as Workload),
        ("coloured", colour_rows),
        ("syntax", syntax_rows),
    ] {
        for cols in [20u16, 40, 80, 120, 200, 279] {
            for lines in [100usize, 1_000, 5_000, 20_000] {
                let budget = scrollback_bytes_for_lines(lines, cols);
                let rt = fed_scrollback(cols, budget, 3 * lines, workload);
                let kept = rt.scrollback_rows().unwrap();
                assert!(
                    kept >= lines,
                    "{name} at {cols} columns, {lines} lines requested: kept only {kept} rows of {budget} bytes"
                );
                assert!(
                    kept * usize::from(cols) * 8 <= budget,
                    "{name} at {cols} columns, {lines} lines requested: kept {kept} rows, the budget does not bound the history"
                );
            }
        }
    }
}

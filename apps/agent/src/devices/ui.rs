//! Accessibility tree of the foreground Android screen (`uiautomator dump`) and an action on one node.
//!
//! `uiautomator` offers no way to run an accessibility action, so an action re-reads the tree,
//! finds the one node with the requested identity and taps or long-presses its centre with `input`.
use super::*;
use std::collections::HashMap;

const MAX_XML: usize = 2 * 1024 * 1024;
const MAX_PARSED: usize = 5000;
const MAX_LISTED: usize = 300;
const MAX_DEPTH: usize = 64;
const MAX_TEXT: usize = 256;
const LONG_PRESS_MS: &str = "700";

#[derive(Subcommand, Debug)]
pub enum UiCommand {
    /// List the labelled and actionable nodes of the foreground screen.
    Tree,
    /// Tap or long-press the one node with this identity, found in a fresh read of the tree.
    Act {
        #[arg(long, value_enum)]
        kind: UiActionKind,
        #[arg(long, default_value = "")]
        resource_id: String,
        #[arg(long, default_value = "")]
        text: String,
        #[arg(long, default_value = "")]
        content_desc: String,
        /// Position among the nodes that share the three identity fields, in tree order.
        #[arg(long, default_value_t = 0)]
        occurrence: u32,
    },
}
#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum UiActionKind {
    Click,
    LongClick,
}

struct Node {
    depth: usize,
    class: String,
    package: String,
    resource_id: String,
    text: String,
    content_desc: String,
    bounds: [i32; 4],
    flags: Flags,
    occurrence: u32,
}
#[derive(Default)]
struct Flags {
    clickable: bool,
    long_clickable: bool,
    scrollable: bool,
    checkable: bool,
    checked: bool,
    enabled: bool,
    focusable: bool,
}
struct Tree {
    rotation: u32,
    nodes: Vec<Node>,
}

fn decode(value: &str) -> Result<String> {
    let mut output = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find('&') {
        output.push_str(&rest[..start]);
        let end = rest[start..]
            .find(';')
            .filter(|end| *end <= 10)
            .ok_or(Error::Device("InvalidAccessibilityTree"))?;
        output.push(match &rest[start + 1..start + end] {
            "amp" => '&',
            "lt" => '<',
            "gt" => '>',
            "quot" => '"',
            "apos" => '\'',
            number => match number.strip_prefix("#x") {
                Some(hex) => u32::from_str_radix(hex, 16).ok(),
                None => number
                    .strip_prefix('#')
                    .and_then(|digits| digits.parse().ok()),
            }
            .and_then(char::from_u32)
            .ok_or(Error::Device("InvalidAccessibilityTree"))?,
        });
        rest = &rest[start + end + 1..];
    }
    output.push_str(rest);
    Ok(output)
}
/// The `name="value"` pairs of one tag; a `>` inside a quoted value does not end the tag.
fn attributes(tag: &str) -> Result<Vec<(&str, String)>> {
    let mut pairs = Vec::new();
    let mut rest = tag;
    while let Some(equals) = rest.find("=\"") {
        let name = rest[..equals]
            .rsplit(|byte: char| byte.is_whitespace())
            .next()
            .unwrap_or("");
        let value = &rest[equals + 2..];
        let end = value
            .find('"')
            .ok_or(Error::Device("InvalidAccessibilityTree"))?;
        pairs.push((name, decode(&value[..end])?));
        rest = &value[end + 1..];
    }
    Ok(pairs)
}
fn bounds(value: &str) -> Option<[i32; 4]> {
    let numbers: Vec<i32> = value
        .split(|byte: char| !(byte.is_ascii_digit() || byte == '-'))
        .filter(|part| !part.is_empty())
        .map(str::parse)
        .collect::<std::result::Result<_, _>>()
        .ok()?;
    <[i32; 4]>::try_from(numbers).ok()
}
fn limit(value: String) -> String {
    value.chars().take(MAX_TEXT).collect()
}
fn parse(xml: &[u8]) -> Result<Tree> {
    let end = b"</hierarchy>";
    let xml = std::str::from_utf8(xml).map_err(|_| Error::Device("InvalidAccessibilityTree"))?;
    // The dump is followed by a status line on the same stream.
    let xml = xml
        .find("</hierarchy>")
        .map(|index| &xml[..index + end.len()])
        .ok_or(Error::Device("InvalidAccessibilityTree"))?;
    let mut tree = Tree {
        rotation: 0,
        nodes: Vec::new(),
    };
    let mut depth = 0_usize;
    let mut seen: HashMap<(String, String, String), u32> = HashMap::new();
    let mut rest = xml;
    while let Some(start) = rest.find('<') {
        // A tag ends at the first `>` outside a quoted value.
        let mut quoted = false;
        let close = rest[start..]
            .char_indices()
            .find(|(_, byte)| {
                quoted ^= *byte == '"';
                *byte == '>' && !quoted
            })
            .map(|(index, _)| start + index)
            .ok_or(Error::Device("InvalidAccessibilityTree"))?;
        let tag = &rest[start + 1..close];
        rest = &rest[close + 1..];
        if let Some(name) = tag.strip_prefix('/') {
            if name.trim() == "node" {
                depth = depth
                    .checked_sub(1)
                    .ok_or(Error::Device("InvalidAccessibilityTree"))?;
            }
        } else if tag.starts_with("hierarchy") {
            let rotation = attributes(tag)?
                .into_iter()
                .find_map(|(name, value)| (name == "rotation").then_some(value));
            tree.rotation = match rotation {
                None => 0,
                Some(value) => value
                    .parse()
                    .ok()
                    .filter(|value| *value < 4)
                    .ok_or(Error::Device("InvalidAccessibilityTree"))?,
            };
        } else if tag.starts_with("node") {
            if tree.nodes.len() == MAX_PARSED || depth >= MAX_DEPTH {
                return Err(Error::Device("AccessibilityTreeTooLarge"));
            }
            let mut node = Node {
                depth,
                class: String::new(),
                package: String::new(),
                resource_id: String::new(),
                text: String::new(),
                content_desc: String::new(),
                bounds: [0; 4],
                flags: Flags::default(),
                occurrence: 0,
            };
            for (name, value) in attributes(tag)? {
                let flag = value == "true";
                match name {
                    "class" => node.class = limit(value),
                    "package" => node.package = limit(value),
                    "resource-id" => node.resource_id = limit(value),
                    "text" => node.text = limit(value),
                    "content-desc" => node.content_desc = limit(value),
                    "bounds" => {
                        node.bounds =
                            bounds(&value).ok_or(Error::Device("InvalidAccessibilityTree"))?
                    }
                    "clickable" => node.flags.clickable = flag,
                    "long-clickable" => node.flags.long_clickable = flag,
                    "scrollable" => node.flags.scrollable = flag,
                    "checkable" => node.flags.checkable = flag,
                    "checked" => node.flags.checked = flag,
                    "enabled" => node.flags.enabled = flag,
                    "focusable" => node.flags.focusable = flag,
                    _ => {}
                }
            }
            let count = seen
                .entry((
                    node.resource_id.clone(),
                    node.text.clone(),
                    node.content_desc.clone(),
                ))
                .or_default();
            node.occurrence = *count;
            *count += 1;
            tree.nodes.push(node);
            if !tag.ends_with('/') {
                depth += 1;
            }
        }
    }
    if depth != 0 || tree.nodes.is_empty() {
        return Err(Error::Device("InvalidAccessibilityTree"));
    }
    Ok(tree)
}
fn dump(runner: &mut impl Runner, id: &str) -> Result<Tree> {
    if !valid_id(Platform::Android, id) {
        return Err(Error::InvalidArgument);
    }
    parse(&runner.output(
        Tool::Adb,
        &args(&["-s", id, "exec-out", "uiautomator", "dump", "/dev/stdout"]),
        MAX_XML,
    )?)
}
fn listed(node: &Node) -> bool {
    let [left, top, right, bottom] = node.bounds;
    right > left
        && bottom > top
        && (!node.text.is_empty()
            || !node.content_desc.is_empty()
            || !node.resource_id.is_empty()
            || node.flags.clickable
            || node.flags.long_clickable
            || node.flags.scrollable
            || node.flags.checkable)
}
fn describe(id: &str, tree: &Tree) -> Value {
    let nodes: Vec<&Node> = tree.nodes.iter().filter(|node| listed(node)).collect();
    let shown: Vec<Value> = nodes.iter().take(MAX_LISTED).map(|node| {
        json!({"depth":node.depth,"class":node.class,"package":node.package,"resourceId":node.resource_id,"text":node.text,"contentDescription":node.content_desc,"bounds":node.bounds,"occurrence":node.occurrence,
            "clickable":node.flags.clickable,"longClickable":node.flags.long_clickable,"scrollable":node.flags.scrollable,"checkable":node.flags.checkable,"checked":node.flags.checked,"enabled":node.flags.enabled,"focusable":node.flags.focusable})
    }).collect();
    json!({"schemaVersion":1,"platform":"android","id":id,"rotation":tree.rotation,"truncated":nodes.len() > shown.len(),"nodes":shown})
}
pub(super) fn execute(runner: &mut impl Runner, id: &str, command: UiCommand) -> Result<Value> {
    let tree = dump(runner, id)?;
    let UiCommand::Act {
        kind,
        resource_id,
        text,
        content_desc,
        occurrence,
    } = command
    else {
        return Ok(describe(id, &tree));
    };
    // The tree holds the same truncated texts a caller was shown.
    let (resource_id, text, content_desc) = (limit(resource_id), limit(text), limit(content_desc));
    let node = tree
        .nodes
        .iter()
        .find(|node| {
            node.resource_id == resource_id
                && node.text == text
                && node.content_desc == content_desc
                && node.occurrence == occurrence
        })
        .ok_or(Error::Device("AccessibilityNodeNotFound"))?;
    let [left, top, right, bottom] = node.bounds;
    if !node.flags.enabled || right <= left || bottom <= top || left < 0 || top < 0 {
        return Err(Error::Device("AccessibilityNodeUnavailable"));
    }
    let (x, y) = ((left + right) / 2, (top + bottom) / 2);
    let (x, y) = (x.to_string(), y.to_string());
    let (operation, arguments) = match kind {
        UiActionKind::Click => ("click", args(&["-s", id, "shell", "input", "tap", &x, &y])),
        UiActionKind::LongClick => (
            "long-click",
            args(&[
                "-s",
                id,
                "shell",
                "input",
                "swipe",
                &x,
                &y,
                &x,
                &y,
                LONG_PRESS_MS,
            ]),
        ),
    };
    adb_requested(runner, id, operation, &arguments)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ATTRIBUTES: &str = r#"package="com.example" checkable="false" checked="false" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false""#;
    fn node(resource_id: &str, text: &str, description: &str, bounds: &str, extra: &str) -> String {
        format!(
            r#"<node index="0" text="{text}" resource-id="{resource_id}" class="android.widget.Button" content-desc="{description}" clickable="true" enabled="true" {ATTRIBUTES} bounds="{bounds}"{extra}"#
        )
    }
    fn dump(children: &[String]) -> Vec<u8> {
        format!(
            "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"1\"><node index=\"0\" text=\"\" resource-id=\"\" class=\"android.widget.FrameLayout\" content-desc=\"\" clickable=\"false\" enabled=\"true\" {ATTRIBUTES} bounds=\"[0,0][1080,1920]\">{}</node></hierarchy>UI hierchary dumped to: /dev/stdout\n",
            children.join("")
        )
        .into_bytes()
    }
    struct Fake {
        outputs: Vec<Vec<u8>>,
        calls: Vec<Vec<String>>,
    }
    impl Runner for Fake {
        fn output(&mut self, tool: Tool, arguments: &[String], _: usize) -> Result<Vec<u8>> {
            assert_eq!(tool, Tool::Adb);
            self.calls.push(arguments.to_vec());
            Ok(self.outputs.remove(0))
        }
        fn launch(&mut self, _: Tool, _: &[String]) -> Result<()> {
            panic!("an accessibility read never launches a process");
        }
    }
    fn fake(outputs: Vec<Vec<u8>>) -> Fake {
        Fake {
            outputs,
            calls: Vec::new(),
        }
    }
    fn act(kind: UiActionKind, resource_id: &str, text: &str, occurrence: u32) -> UiCommand {
        UiCommand::Act {
            kind,
            resource_id: resource_id.into(),
            text: text.into(),
            content_desc: String::new(),
            occurrence,
        }
    }

    #[test]
    fn the_tree_lists_labelled_and_actionable_nodes_with_decoded_text_and_stable_occurrences() {
        let xml = dump(&[
            node("com.example:id/ok", "Fish &amp; &quot;chips&quot;&#10;&#x1F41F;", "", "[10,20][110,220]", " />"),
            node("com.example:id/ok", "", "", "[0,0][0,0]", " />"), // no area: not listed
            node("", "Twin", "", "[0,300][100,400]", " />"),
            node("", "Twin", "", "[0,400][100,500]", " />"),
            r#"<node index="1" text="" resource-id="" class="android.view.View" content-desc="" clickable="false" enabled="true" bounds="[0,0][5,5]" />"#.into(), // plain container: not listed
        ]);
        let result = execute(&mut fake(vec![xml]), "emulator-5554", UiCommand::Tree).unwrap();
        assert_eq!(result["rotation"], 1);
        assert_eq!(result["truncated"], false);
        let nodes = result["nodes"].as_array().unwrap();
        let labels: Vec<_> = nodes
            .iter()
            .map(|node| node["text"].as_str().unwrap())
            .collect();
        assert_eq!(labels, ["Fish & \"chips\"\n🐟", "Twin", "Twin"]);
        assert_eq!(nodes[0]["bounds"], json!([10, 20, 110, 220]));
        assert_eq!(nodes[0]["depth"], 1);
        assert_eq!(
            (
                nodes[1]["occurrence"].as_u64(),
                nodes[2]["occurrence"].as_u64()
            ),
            (Some(0), Some(1))
        );
    }

    #[test]
    fn an_action_re_reads_the_tree_and_touches_only_the_centre_of_the_one_matching_enabled_node() {
        let xml = dump(&[
            node("", "Twin", "", "[0,300][100,400]", " />"),
            node("", "Twin", "", "[0,400][100,500]", " />"),
            node("", "Off", "", "[0,0][100,100]", r#" />"#)
                .replace(r#"enabled="true""#, r#"enabled="false""#),
        ]);
        let mut runner = fake(vec![
            xml.clone(),
            vec![],
            xml.clone(),
            vec![],
            xml.clone(),
            xml.clone(),
            xml.clone(),
        ]);
        let click = execute(
            &mut runner,
            "emulator-5554",
            act(UiActionKind::Click, "", "Twin", 1),
        )
        .unwrap();
        assert_eq!(click["operation"], "click");
        assert_eq!(
            runner.calls[0],
            args(&[
                "-s",
                "emulator-5554",
                "exec-out",
                "uiautomator",
                "dump",
                "/dev/stdout"
            ])
        );
        assert_eq!(
            runner.calls[1],
            args(&["-s", "emulator-5554", "shell", "input", "tap", "50", "450"])
        );
        execute(
            &mut runner,
            "emulator-5554",
            act(UiActionKind::LongClick, "", "Twin", 0),
        )
        .unwrap();
        assert_eq!(
            runner.calls[3],
            args(&[
                "-s",
                "emulator-5554",
                "shell",
                "input",
                "swipe",
                "50",
                "350",
                "50",
                "350",
                "700"
            ])
        );
        for (text, occurrence, failure) in [
            ("Twin", 2, "AccessibilityNodeNotFound"),
            ("Absent", 0, "AccessibilityNodeNotFound"),
            ("Off", 0, "AccessibilityNodeUnavailable"),
        ] {
            let before = runner.calls.len();
            assert!(matches!(
                execute(&mut runner, "emulator-5554", act(UiActionKind::Click, "", text, occurrence)),
                Err(Error::Device(kind)) if kind == failure
            ));
            assert_eq!(runner.calls.len(), before + 1, "only the tree was read");
        }
    }

    #[test]
    fn malformed_oversized_or_foreign_output_fails_closed_and_hostile_ids_reach_no_sdk() {
        let deep = format!(
            "{}{}",
            r#"<node bounds="[0,0][1,1]">"#.repeat(65),
            "</node>".repeat(65)
        );
        let wide = r#"<node bounds="[0,0][1,1]" />"#.repeat(MAX_PARSED + 1);
        for xml in [
            b"ERROR: could not get idle state.\n".to_vec(),
            b"<hierarchy rotation=\"0\"></hierarchy>".to_vec(),
            b"<hierarchy rotation=\"9\"><node bounds=\"[0,0][1,1]\" /></hierarchy>".to_vec(),
            b"<hierarchy rotation=\"0\"><node bounds=\"[0,0][1,1]\"></hierarchy>".to_vec(),
            b"<hierarchy rotation=\"0\"><node bounds=\"[0,x][1,1]\" /></hierarchy>".to_vec(),
            b"<hierarchy rotation=\"0\"><node text=\"&bogus;\" bounds=\"[0,0][1,1]\" /></hierarchy>".to_vec(),
            format!("<hierarchy rotation=\"0\">{deep}</hierarchy>").into_bytes(),
            format!("<hierarchy rotation=\"0\">{wide}</hierarchy>").into_bytes(),
            vec![0xff, 0xfe],
        ] {
            assert!(execute(&mut fake(vec![xml]), "emulator-5554", UiCommand::Tree).is_err());
        }
        let mut runner = fake(vec![]);
        assert!(execute(&mut runner, "-s", UiCommand::Tree).is_err());
        assert!(runner.calls.is_empty());
    }
}

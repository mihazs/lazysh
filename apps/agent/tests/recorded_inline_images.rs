use base64::{engine::general_purpose::STANDARD, Engine};
use lazysh_agent::transcript::{
    claude_conversation_images, conversation, read_inline_images, read_page, TranscriptAgent,
};
use serde_json::{json, Value};
use std::fs;

#[path = "support/jsonl.rs"]
mod jsonl;
#[path = "support/recorded_image.rs"]
mod recorded_image;
use recorded_image::{JPEG, PNG};

mod recorded_inline_images {
    use super::*;
    pub mod claude;
    pub mod codex;
}

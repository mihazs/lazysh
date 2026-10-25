// Field numbers follow Eternal Terminal 7.0.0 proto/ET.proto and ETerminal.proto.
use prost::Message;

#[derive(Clone, PartialEq, Message)]
pub(crate) struct ConnectRequest {
    #[prost(string, optional, tag = "1")]
    pub client_id: Option<String>,
    #[prost(int32, optional, tag = "2")]
    pub version: Option<i32>,
}
#[derive(Clone, PartialEq, Message)]
pub(crate) struct ConnectResponse {
    #[prost(int32, optional, tag = "1")]
    pub status: Option<i32>,
    #[prost(string, optional, tag = "2")]
    pub error: Option<String>,
    // Recognize the development capability to refuse an unimplemented downgrade.
    #[prost(bytes = "vec", optional, tag = "3")]
    pub auth_challenge: Option<Vec<u8>>,
    #[prost(bool, optional, tag = "4")]
    pub reset_required: Option<bool>,
}
#[derive(Clone, PartialEq, Message)]
pub(crate) struct SequenceHeader {
    #[prost(int32, optional, tag = "1")]
    pub sequence_number: Option<i32>,
    #[prost(bool, optional, tag = "2")]
    pub reset: Option<bool>,
}
#[derive(Clone, PartialEq, Message)]
pub(crate) struct CatchupBuffer {
    #[prost(bytes = "vec", repeated, tag = "1")]
    pub buffer: Vec<Vec<u8>>,
}
#[derive(Clone, PartialEq, Message)]
pub(crate) struct InitialPayload {
    #[prost(bool, optional, tag = "1")]
    pub jumphost: Option<bool>,
}
#[derive(Clone, PartialEq, Message)]
pub(crate) struct InitialResponse {
    #[prost(string, optional, tag = "1")]
    pub error: Option<String>,
}
#[derive(Clone, PartialEq, Message)]
pub(crate) struct TerminalBuffer {
    #[prost(bytes = "vec", optional, tag = "1")]
    pub buffer: Option<Vec<u8>>,
}
#[derive(Clone, PartialEq, Message)]
pub(crate) struct TerminalInfo {
    #[prost(string, optional, tag = "1")]
    pub id: Option<String>,
    #[prost(int32, optional, tag = "2")]
    pub row: Option<i32>,
    #[prost(int32, optional, tag = "3")]
    pub column: Option<i32>,
}

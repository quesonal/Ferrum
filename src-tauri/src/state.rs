use std::sync::Mutex;

pub struct PendingFile(pub Mutex<Option<String>>);

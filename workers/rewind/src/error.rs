//! Rewind's own errors. Each kind has a code, such as `REWIND_NOT_FOUND`, that the page and the
//! end-to-end check switch on. An error turns into an `iii_sdk::Error::Remote` with that code only
//! where a function handler returns, and an error from the engine or the SDK goes back out as it came.

/// What went wrong, with the code `code()` gives each kind.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    BadInput(String),
    #[error("{0}")]
    NotFound(String),
    /// A fork asked to change a seq the run has no call at.
    #[error("{0}")]
    BadSeq(String),
    #[error("{0}")]
    NotPaused(String),
    #[error("{0}")]
    ChoiceNotAllowed(String),
    /// What a stub returns to a copy once its rerun has paused, or when no rerun is in progress.
    #[error("{0}")]
    Paused(String),
    #[error("{0}")]
    NotRegistered(String),
    #[error("{0}")]
    StillRegistered(String),
    #[error("{0}")]
    CodeUnreadable(String),
    #[error("{0}")]
    CopySpawn(String),
    #[error("{0}")]
    CopyExited(String),
    #[error("{0}")]
    CopyNotListening(String),
    #[error("{0}")]
    NotReplayable(String),
    /// A request whose body the preload cut, which Rewind won't send or replay.
    #[error("{0}")]
    BodyTruncated(String),
    #[error("{0}")]
    BadRecording(String),
    /// A fork saved as a test while it still waits for an answer.
    #[error("{0}")]
    ForkPaused(String),
    #[error("{0}")]
    Write(String),
    #[error("{0}")]
    BadFixture(String),
    #[error("{0}")]
    NoCompose(String),
    #[error("{0}")]
    UnknownUiAsset(String),
    #[error("{0}")]
    Internal(String),
    #[error(transparent)]
    Store(#[from] rusqlite::Error),
    /// The store's folder, or a stored value Rewind could not read or write.
    #[error("{0}")]
    StoreData(String),
    #[error(transparent)]
    Spans(rusqlite::Error),
    #[error("{0}")]
    SpansFile(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Sdk(#[from] iii_sdk::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    /// The code the caller sees. An SDK error keeps its own.
    pub fn code(&self) -> &str {
        match self {
            Error::BadInput(_) => "REWIND_BAD_INPUT",
            Error::NotFound(_) => "REWIND_NOT_FOUND",
            Error::BadSeq(_) => "REWIND_BAD_SEQ",
            Error::NotPaused(_) => "REWIND_NOT_PAUSED",
            Error::ChoiceNotAllowed(_) => "REWIND_CHOICE_NOT_ALLOWED",
            Error::Paused(_) => "REWIND_PAUSED",
            Error::NotRegistered(_) => "REWIND_NOT_REGISTERED",
            Error::StillRegistered(_) => "REWIND_STILL_REGISTERED",
            Error::CodeUnreadable(_) => "REWIND_CODE_UNREADABLE",
            Error::CopySpawn(_) => "REWIND_COPY_SPAWN",
            Error::CopyExited(_) => "REWIND_COPY_EXITED",
            Error::CopyNotListening(_) => "REWIND_COPY_NOT_LISTENING",
            Error::NotReplayable(_) => "REWIND_NOT_REPLAYABLE",
            Error::BodyTruncated(_) => crate::outside::BODY_CUT_CODE,
            Error::BadRecording(_) => "REWIND_BAD_RECORDING",
            Error::ForkPaused(_) => "REWIND_FORK_PAUSED",
            Error::Write(_) => "REWIND_WRITE",
            Error::BadFixture(_) => "REWIND_BAD_FIXTURE",
            Error::NoCompose(_) => "REWIND_NO_COMPOSE",
            Error::UnknownUiAsset(_) => "UNKNOWN_UI_ASSET",
            Error::Internal(_) => "REWIND_INTERNAL",
            Error::Store(_) | Error::StoreData(_) => "REWIND_STORE",
            Error::Spans(_) | Error::SpansFile(_) => "REWIND_SPANS",
            Error::Io(_) => "REWIND_IO",
            Error::Sdk(iii_sdk::Error::Remote { code, .. }) => code,
            Error::Sdk(iii_sdk::Error::Timeout) => "TIMEOUT",
            Error::Sdk(_) => crate::types::DEFAULT_ERROR_CODE,
        }
    }
}

impl From<Error> for iii_sdk::Error {
    fn from(error: Error) -> Self {
        if let Error::Sdk(sdk) = error {
            return sdk;
        }

        iii_sdk::Error::Remote {
            code: error.code().to_string(),
            message: error.to_string(),
            stacktrace: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rewind_error_reaches_the_caller_with_its_code_and_message() {
        let sent = iii_sdk::Error::from(Error::NotFound("no fork f9".into()));
        let iii_sdk::Error::Remote { code, message, .. } = sent else {
            panic!("expected a remote error");
        };
        assert_eq!((code.as_str(), message.as_str()), ("REWIND_NOT_FOUND", "no fork f9"));
    }

    #[test]
    fn an_engine_error_goes_back_out_as_it_came() {
        let engine = iii_sdk::Error::Remote {
            code: "function_not_found".into(),
            message: "Function x not found".into(),
            stacktrace: Some("at y".into()),
        };
        let passed_on = iii_sdk::Error::from(Error::from(engine.clone()));
        assert_eq!(passed_on.to_string(), engine.to_string());
        assert!(matches!(iii_sdk::Error::from(Error::from(iii_sdk::Error::Timeout)), iii_sdk::Error::Timeout));
    }
}

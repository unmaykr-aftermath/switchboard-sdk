use serde::ser::StdError;
use std::fmt;

#[derive(Clone, Debug)]
#[repr(u32)]
pub enum OnDemandError {
    Generic,
    AccountBorrowError,
    AccountNotFound,
    AnchorParse,
    AnchorParseError,
    CheckSizeError,
    DecimalConversionError,
    DecryptError,
    EventListenerRoutineFailure,
    EvmError,
    FunctionResultIxIncorrectTargetChain,
    HeartbeatRoutineFailure,
    IntegerOverflowError,
    InvalidChain,
    InvalidData,
    InvalidDiscriminator,
    InvalidInstructionError,
    InvalidKeypairFile,
    InvalidNativeMint,
    InvalidQuote,
    InvalidQuoteError,
    InvalidSignature,
    IpfsNetworkError,
    IpfsParseError,
    KeyParseError,
    MrEnclaveMismatch,
    NetworkError,
    ParseError,
    PdaDerivationError,
    QuoteParseError,
    QvnTxSendFailure,
    SgxError,
    SgxWriteError,
    SolanaBlockhashError,
    SolanaMissingSigner,
    SolanaPayerSignerMissing,
    SolanaPayerMismatch,
    SolanaInstructionOverflow,
    SolanaInstructionsEmpty,
    TxCompileErr,
    TxDeserializationError,
    TxFailure,
    Unexpected,
    SolanaSignError,
    IoError,
    KeyDerivationFailed,
    InvalidSecretKey,
    EnvVariableMissing,
    AccountDeserializeError,
    NotEnoughSamples,
    IllegalFeedValue,
    CustomMessage(String),
    SwitchboardRandomnessTooOld,
    AddressLookupTableFetchError,
    AddressLookupTableDeserializeError,
}

impl StdError for OnDemandError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        None
    }
}
impl fmt::Display for OnDemandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:#?}", self)
    }
}

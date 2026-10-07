/// Selects the process's TLS crypto provider before a `wss://` dial. Both `ring` and `aws-lc-rs`
/// are compiled into rustls here, so it cannot choose one itself and panics instead.
pub fn install_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    }
}

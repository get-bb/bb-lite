const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const LAST_DIGIT: usize = DIGITS.len() - 1;

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum OrderKeyError {
    #[error("Order keys must ascend")]
    NotAscending,
    #[error("Invalid order key '{0}'")]
    Invalid(String),
}

fn digit_at(key: Option<&str>, index: usize, fallback: usize) -> Result<usize, OrderKeyError> {
    let Some(key) = key else { return Ok(fallback) };
    let Some(&byte) = key.as_bytes().get(index) else { return Ok(fallback) };
    DIGITS
        .iter()
        .position(|&digit| digit == byte)
        .ok_or_else(|| OrderKeyError::Invalid(key.to_owned()))
}

/// A key that sorts strictly between `previous` and `next` (`None` is an open end).
pub fn order_key_between(
    previous: Option<&str>,
    next: Option<&str>,
) -> Result<String, OrderKeyError> {
    if let (Some(previous), Some(next)) = (previous, next)
        && previous >= next
    {
        return Err(OrderKeyError::NotAscending);
    }
    let mut prefix = String::new();
    let mut index = 0;
    loop {
        let low = digit_at(previous, index, 0)?;
        let high = digit_at(next, index, LAST_DIGIT)?;
        if high > low + 1 {
            prefix.push(DIGITS[(low + high) / 2] as char);
            return Ok(prefix);
        }
        prefix.push(DIGITS[low] as char);
        index += 1;
    }
}

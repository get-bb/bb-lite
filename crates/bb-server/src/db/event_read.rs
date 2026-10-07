use super::{Db, DbResult};

pub fn latest_sequence(db: &Db, thread_id: &str) -> DbResult<i64> {
    let sql = "SELECT MAX(sequence) AS latest FROM events WHERE thread_id = ?";
    Ok(db.scalar::<Option<i64>>(sql, [thread_id])?.flatten().unwrap_or(0))
}

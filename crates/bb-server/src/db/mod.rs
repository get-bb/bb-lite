//! The SQLite connection and the generic row helpers. Query modules for each
//! table live beside this file and take `&Db`.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use parking_lot::ReentrantMutex;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Connection, OpenFlags, Params, ToSql};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

pub use bb_core::new_id;
pub use rusqlite::{named_params, params};

const BUSY_TIMEOUT_MS: u64 = 5_000;
const SCHEMA: &str = include_str!("../../../../apps/server/src/db/schema.sql");

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("{0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("row does not match its type: {0}")]
    Decode(#[from] serde_json::Error),
}

pub type DbResult<T> = Result<T, DbError>;

impl DbError {
    /// True when a UNIQUE, PRIMARY KEY, CHECK or FOREIGN KEY constraint refused the write.
    pub fn is_constraint(&self) -> bool {
        matches!(
            self,
            DbError::Sqlite(rusqlite::Error::SqliteFailure(error, _))
                if error.code == rusqlite::ErrorCode::ConstraintViolation
        )
    }
}

#[derive(Debug, thiserror::Error)]
#[error(
    "{path} belongs to an original bb install (it has a __drizzle_migrations table). This build \
     never opens that data in place: point BB_DATA_DIR at another directory and copy what you \
     need across with `bb import-legacy`."
)]
pub struct LegacyDataDirectoryError {
    pub path: String,
}

#[derive(Debug, thiserror::Error)]
pub enum OpenError {
    #[error(transparent)]
    Legacy(#[from] LegacyDataDirectoryError),
    #[error(transparent)]
    Db(#[from] DbError),
}

impl From<rusqlite::Error> for OpenError {
    fn from(error: rusqlite::Error) -> Self {
        OpenError::Db(error.into())
    }
}

pub type NowFn = Arc<dyn Fn() -> i64 + Send + Sync>;

struct Inner {
    connection: ReentrantMutex<Connection>,
    depth: AtomicUsize,
    now: NowFn,
}

/// One SQLite connection. Calls are synchronous and short, as with
/// better-sqlite3; a transaction holds the connection for its whole closure.
#[derive(Clone)]
pub struct Db {
    inner: Arc<Inner>,
}

pub fn refuse_legacy_database(path: &Path) -> Result<(), OpenError> {
    if !path.exists() {
        return Ok(());
    }
    let sqlite = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let sql = "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?";
    let legacy = sqlite.prepare(sql)?.exists(["__drizzle_migrations"])?;
    if legacy {
        return Err(LegacyDataDirectoryError { path: path.display().to_string() }.into());
    }
    Ok(())
}

fn migrate(sqlite: &Connection) -> rusqlite::Result<()> {
    let steps = [SCHEMA];
    let current: i64 = sqlite.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    for (offset, step) in steps.iter().enumerate().skip(current.max(0) as usize) {
        sqlite.execute_batch("BEGIN IMMEDIATE")?;
        let applied = sqlite
            .execute_batch(step)
            .and_then(|()| sqlite.pragma_update(None, "user_version", offset as i64 + 1));
        match applied {
            Ok(()) => sqlite.execute_batch("COMMIT")?,
            Err(error) => {
                let _ = sqlite.execute_batch("ROLLBACK");
                return Err(error);
            }
        }
    }
    Ok(())
}

fn camel_case(column: &str) -> String {
    let mut out = String::with_capacity(column.len());
    let mut chars = column.chars().peekable();
    while let Some(c) = chars.next() {
        let next = chars.peek().copied();
        if c == '_' && next.is_some_and(|n| n.is_ascii_lowercase() || n.is_ascii_digit()) {
            out.push(next.unwrap_or(c).to_ascii_uppercase());
            chars.next();
        } else {
            out.push(c);
        }
    }
    out
}

pub fn snake_case(key: &str) -> String {
    let mut out = String::with_capacity(key.len() + 4);
    for c in key.chars() {
        if c.is_ascii_uppercase() {
            out.push('_');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

fn cell(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(number) => Value::from(number),
        ValueRef::Real(number) => Value::from(number),
        ValueRef::Text(text) => Value::String(String::from_utf8_lossy(text).into_owned()),
        ValueRef::Blob(bytes) => {
            Value::Array(bytes.iter().map(|byte| Value::from(*byte)).collect())
        }
    }
}

fn configure(sqlite: &Connection) -> rusqlite::Result<()> {
    sqlite.pragma_update(None, "journal_mode", "WAL")?;
    sqlite.pragma_update(None, "foreign_keys", "ON")?;
    sqlite.pragma_update(None, "synchronous", "NORMAL")?;
    sqlite.busy_timeout(std::time::Duration::from_millis(BUSY_TIMEOUT_MS))?;
    sqlite.set_prepared_statement_cache_capacity(512);
    migrate(sqlite)
}

impl Db {
    pub fn open(path: &Path, now: Option<NowFn>) -> Result<Db, OpenError> {
        refuse_legacy_database(path)?;
        Self::from_connection(Connection::open(path)?, now)
    }

    pub fn open_in_memory(now: Option<NowFn>) -> Result<Db, OpenError> {
        Self::from_connection(Connection::open_in_memory()?, now)
    }

    fn from_connection(sqlite: Connection, now: Option<NowFn>) -> Result<Db, OpenError> {
        configure(&sqlite)?;
        let now = now.unwrap_or_else(|| Arc::new(bb_core::now_ms));
        let connection = ReentrantMutex::new(sqlite);
        Ok(Db { inner: Arc::new(Inner { connection, depth: AtomicUsize::new(0), now }) })
    }

    pub fn now(&self) -> i64 {
        (self.inner.now)()
    }

    /// Rows as JSON objects keyed by the camelCase of each column name.
    pub fn rows(&self, sql: &str, params: impl Params) -> DbResult<Vec<Map<String, Value>>> {
        let connection = self.inner.connection.lock();
        let mut statement = connection.prepare_cached(sql)?;
        let keys: Vec<String> = statement.column_names().into_iter().map(camel_case).collect();
        let mut rows = statement.query(params)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            let mut object = Map::with_capacity(keys.len());
            for (index, key) in keys.iter().enumerate() {
                object.insert(key.clone(), cell(row.get_ref(index)?));
            }
            out.push(object);
        }
        Ok(out)
    }

    pub fn get<T: DeserializeOwned>(&self, sql: &str, params: impl Params) -> DbResult<Option<T>> {
        let first = self.rows(sql, params)?.into_iter().next();
        Ok(first.map(|row| serde_json::from_value(Value::Object(row))).transpose()?)
    }

    pub fn all<T: DeserializeOwned>(&self, sql: &str, params: impl Params) -> DbResult<Vec<T>> {
        let rows = self.rows(sql, params)?;
        let decoded = rows.into_iter().map(|row| serde_json::from_value(Value::Object(row)));
        Ok(decoded.collect::<Result<_, _>>()?)
    }

    /// The first column of the first row.
    pub fn scalar<T: rusqlite::types::FromSql>(
        &self,
        sql: &str,
        params: impl Params,
    ) -> DbResult<Option<T>> {
        let connection = self.inner.connection.lock();
        let mut statement = connection.prepare_cached(sql)?;
        let mut rows = statement.query(params)?;
        Ok(match rows.next()? {
            Some(row) => Some(row.get(0)?),
            None => None,
        })
    }

    /// Runs a write and returns the number of rows it changed.
    pub fn run(&self, sql: &str, params: impl Params) -> DbResult<usize> {
        let connection = self.inner.connection.lock();
        let mut statement = connection.prepare_cached(sql)?;
        Ok(statement.execute(params)?)
    }

    pub fn exec_batch(&self, sql: &str) -> DbResult<()> {
        Ok(self.inner.connection.lock().execute_batch(sql)?)
    }

    /// Runs `work` in an immediate transaction (a savepoint when nested) and
    /// rolls back when it returns `Err` or panics. `work` must not await.
    pub fn transaction<T, E: From<DbError>>(
        &self,
        work: impl FnOnce() -> Result<T, E>,
    ) -> Result<T, E> {
        let connection = self.inner.connection.lock();
        let depth = self.inner.depth.fetch_add(1, Ordering::SeqCst);
        let scope = TransactionScope { db: self, connection: &connection, depth, open: false };
        let scope = scope.begin().map_err(|error| E::from(DbError::from(error)))?;
        let result = work()?;
        scope.commit().map_err(|error| E::from(DbError::from(error)))?;
        Ok(result)
    }

    pub fn in_transaction(&self) -> bool {
        self.inner.depth.load(Ordering::SeqCst) > 0
    }
}

struct TransactionScope<'a> {
    db: &'a Db,
    connection: &'a Connection,
    depth: usize,
    open: bool,
}

impl<'a> TransactionScope<'a> {
    fn begin(mut self) -> rusqlite::Result<Self> {
        let sql = match self.depth {
            0 => "BEGIN IMMEDIATE".to_owned(),
            depth => format!("SAVEPOINT bb_{depth}"),
        };
        self.connection.execute_batch(&sql)?;
        self.open = true;
        Ok(self)
    }

    fn commit(mut self) -> rusqlite::Result<()> {
        let sql = match self.depth {
            0 => "COMMIT".to_owned(),
            depth => format!("RELEASE bb_{depth}"),
        };
        self.connection.execute_batch(&sql)?;
        self.open = false;
        Ok(())
    }
}

impl Drop for TransactionScope<'_> {
    fn drop(&mut self) {
        if self.open {
            let sql = match self.depth {
                0 => "ROLLBACK".to_owned(),
                depth => format!("ROLLBACK TO bb_{depth}; RELEASE bb_{depth}"),
            };
            let _ = self.connection.execute_batch(&sql);
        }
        self.db.inner.depth.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Column values for a generated INSERT or UPDATE, keyed by camelCase name.
/// A key that was never set is left to the column default, like `undefined`
/// in the TypeScript `RowValues`.
#[derive(Clone, Debug, Default)]
pub struct RowValues {
    cells: Vec<(String, SqlValue)>,
}

impl RowValues {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(mut self, key: &str, value: impl Into<SqlCell>) -> Self {
        self.put(key, value);
        self
    }

    /// Sets the key only when `value` is `Some`.
    pub fn set_some<V: Into<SqlCell>>(mut self, key: &str, value: Option<V>) -> Self {
        if let Some(value) = value {
            self.put(key, value);
        }
        self
    }

    pub fn put(&mut self, key: &str, value: impl Into<SqlCell>) {
        let value = value.into().0;
        match self.cells.iter_mut().find(|(name, _)| name == key) {
            Some(cell) => cell.1 = value,
            None => self.cells.push((key.to_owned(), value)),
        }
    }

    pub fn get(&self, key: &str) -> Option<&SqlValue> {
        self.cells.iter().find(|(name, _)| name == key).map(|(_, value)| value)
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.cells.iter().map(|(name, _)| name.as_str())
    }

    pub fn is_empty(&self) -> bool {
        self.cells.is_empty()
    }

    fn bindings(&self) -> Vec<(String, &dyn ToSql)> {
        self.cells.iter().map(|(name, value)| (format!(":{name}"), value as &dyn ToSql)).collect()
    }
}

/// A value on its way into a column; `Option::None` and `()` become NULL,
/// booleans become 0 or 1.
pub struct SqlCell(pub SqlValue);

macro_rules! sql_cell_from {
    ($($from:ty => |$value:ident| $into:expr),* $(,)?) => {
        $(impl From<$from> for SqlCell {
            fn from($value: $from) -> Self { SqlCell($into) }
        })*
    };
}

sql_cell_from! {
    SqlValue => |value| value,
    String => |value| SqlValue::Text(value),
    &str => |value| SqlValue::Text(value.to_owned()),
    &String => |value| SqlValue::Text(value.clone()),
    i64 => |value| SqlValue::Integer(value),
    i32 => |value| SqlValue::Integer(value.into()),
    u32 => |value| SqlValue::Integer(value.into()),
    usize => |value| SqlValue::Integer(value as i64),
    u64 => |value| SqlValue::Integer(value as i64),
    f64 => |value| SqlValue::Real(value),
    bool => |value| SqlValue::Integer(value.into()),
    () => |_value| SqlValue::Null,
}

impl<V: Into<SqlCell>> From<Option<V>> for SqlCell {
    fn from(value: Option<V>) -> Self {
        value.map_or(SqlCell(SqlValue::Null), Into::into)
    }
}

/// `row! { "id" => id, "name" => name }` builds a [`RowValues`].
#[macro_export]
macro_rules! row {
    ($($key:literal => $value:expr),* $(,)?) => {{
        #[allow(unused_mut)]
        let mut values = $crate::db::RowValues::new();
        $(values.put($key, $value);)*
        values
    }};
}

pub enum OnConflict<'a> {
    Fail,
    Ignore,
    /// Update every other column (except `created_at`) when these columns collide.
    Update(&'a [&'a str]),
}

pub fn insert_row(
    db: &Db,
    table: &str,
    values: &RowValues,
    on_conflict: OnConflict<'_>,
) -> DbResult<()> {
    let columns: Vec<String> = values.keys().map(snake_case).collect();
    let marks: Vec<String> = values.keys().map(|key| format!(":{key}")).collect();
    let resolution = match on_conflict {
        OnConflict::Fail => String::new(),
        OnConflict::Ignore => "ON CONFLICT DO NOTHING".to_owned(),
        OnConflict::Update(target) => {
            let kept =
                |column: &&String| !target.contains(&column.as_str()) && *column != "created_at";
            let sets: Vec<String> = columns
                .iter()
                .filter(kept)
                .map(|column| format!("{column} = excluded.{column}"))
                .collect();
            format!("ON CONFLICT ({}) DO UPDATE SET {}", target.join(", "), sets.join(", "))
        }
    };
    let sql = format!(
        "INSERT INTO {table} ({}) VALUES ({}) {resolution}",
        columns.join(", "),
        marks.join(", ")
    );
    let bindings = values.bindings();
    let named: Vec<(&str, &dyn ToSql)> =
        bindings.iter().map(|(name, value)| (name.as_str(), *value)).collect();
    db.run(&sql, named.as_slice())?;
    Ok(())
}

/// Updates one row by id; `touch` also sets `updated_at` to now. Returns
/// whether a row changed.
pub fn update_row(
    db: &Db,
    table: &str,
    id: &str,
    patch: &RowValues,
    touch: bool,
) -> DbResult<bool> {
    let mut values = patch.clone();
    if touch {
        values.put("updatedAt", db.now());
    }
    let sets: Vec<String> =
        values.keys().map(|key| format!("{} = :{key}", snake_case(key))).collect();
    if sets.is_empty() {
        return Ok(false);
    }
    values.put("id", id);
    let sql = format!("UPDATE {table} SET {} WHERE id = :id", sets.join(", "));
    let bindings = values.bindings();
    let named: Vec<(&str, &dyn ToSql)> =
        bindings.iter().map(|(name, value)| (name.as_str(), *value)).collect();
    Ok(db.run(&sql, named.as_slice())? > 0)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RevisionOutcome {
    Updated,
    Conflict,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RevisionWrite {
    pub outcome: RevisionOutcome,
    pub revision: i64,
}

/// Upserts a row that carries a `revision`, refusing when `expected_revision`
/// is given and is not the stored one.
pub fn write_revision(
    db: &Db,
    table: &str,
    key_name: &str,
    row: &RowValues,
    expected_revision: Option<i64>,
) -> DbResult<RevisionWrite> {
    db.transaction(|| {
        let column = snake_case(key_name);
        let key = row.get(key_name).cloned().unwrap_or(SqlValue::Null);
        let sql = format!("SELECT revision FROM {table} WHERE {column} = ?");
        let current: i64 = db.scalar(&sql, [key])?.unwrap_or(0);
        if expected_revision.is_some_and(|expected| expected != current) {
            return Ok(RevisionWrite { outcome: RevisionOutcome::Conflict, revision: current });
        }
        let revision = current + 1;
        let mut next = row.clone();
        next.put("revision", revision);
        next.put("updatedAt", db.now());
        insert_row(db, table, &next, OnConflict::Update(&[column.as_str()]))?;
        Ok(RevisionWrite { outcome: RevisionOutcome::Updated, revision })
    })
}

/// Serde helper for INTEGER columns that hold 0 or 1.
pub mod int_bool {
    use serde::{Deserialize, Deserializer};

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
        Ok(i64::deserialize(deserializer)? != 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct Section {
        id: String,
        name: String,
        created_at: i64,
        updated_at: i64,
    }

    fn open() -> Db {
        Db::open_in_memory(Some(Arc::new(|| 42))).unwrap()
    }

    #[test]
    fn migrates_and_maps_rows() {
        let db = open();
        let version: i64 = db.scalar("PRAGMA user_version", []).unwrap().unwrap();
        assert_eq!(version, 1);
        let values =
            row! { "id" => "sec_1", "name" => "Later", "createdAt" => 1, "updatedAt" => 1 };
        insert_row(&db, "thread_sections", &values, OnConflict::Fail).unwrap();
        let section: Section =
            db.get("SELECT * FROM thread_sections WHERE id = ?", ["sec_1"]).unwrap().unwrap();
        assert_eq!(section.name, "Later");
        assert!(
            update_row(&db, "thread_sections", "sec_1", &row! { "name" => "Soon" }, true).unwrap()
        );
        let all: Vec<Section> = db.all("SELECT * FROM thread_sections", []).unwrap();
        assert_eq!((all[0].name.as_str(), all[0].updated_at, all[0].created_at), ("Soon", 42, 1));
        let duplicate = insert_row(&db, "thread_sections", &values, OnConflict::Fail).unwrap_err();
        assert!(duplicate.is_constraint());
    }

    #[test]
    fn transactions_roll_back_and_nest() {
        let db = open();
        let insert = |id: &str| {
            let values = row! { "id" => id, "name" => id, "createdAt" => 1, "updatedAt" => 1 };
            insert_row(&db, "thread_sections", &values, OnConflict::Fail)
        };
        let failed: DbResult<()> = db.transaction(|| {
            insert("a")?;
            insert("a")
        });
        assert!(failed.is_err());
        let kept: DbResult<()> = db.transaction(|| {
            insert("b")?;
            let inner: DbResult<()> = db.transaction(|| {
                insert("c")?;
                insert("b")
            });
            assert!(inner.is_err());
            insert("d")
        });
        kept.unwrap();
        let ids: Vec<String> = db
            .rows("SELECT id FROM thread_sections ORDER BY id", [])
            .unwrap()
            .into_iter()
            .map(|row| row["id"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(ids, ["b", "d"]);
        assert!(!db.in_transaction());
    }

    #[test]
    fn revision_writes_detect_conflicts() {
        let db = open();
        let value = row! { "key" => "sidebar", "valueJson" => "{}" };
        let first = write_revision(&db, "ui_preferences", "key", &value, None).unwrap();
        assert_eq!(first, RevisionWrite { outcome: RevisionOutcome::Updated, revision: 1 });
        let stale = write_revision(&db, "ui_preferences", "key", &value, Some(0)).unwrap();
        assert_eq!(stale, RevisionWrite { outcome: RevisionOutcome::Conflict, revision: 1 });
        let next = write_revision(&db, "ui_preferences", "key", &value, Some(1)).unwrap();
        assert_eq!(next.revision, 2);
    }

    #[test]
    fn refuses_an_original_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bb.db");
        Connection::open(&path)
            .unwrap()
            .execute_batch("CREATE TABLE __drizzle_migrations (id)")
            .unwrap();
        assert!(matches!(Db::open(&path, None), Err(OpenError::Legacy(_))));
    }
}

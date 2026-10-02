import { atomWithStorage } from "jotai/utils";

export interface SyncStorage<T> {
  getItem: (key: string, initialValue: T) => T;
  setItem: (key: string, newValue: T) => void;
  removeItem: (key: string) => void;
}

interface StoredValueCodec<T> {
  parse: (storedValue: string | null, initialValue: T) => T;
  serialize: (value: T) => string | null;
}

type StorageArea = "localStorage" | "sessionStorage";

function read(area: StorageArea, key: string): string | null {
  try {
    return window[area].getItem(key);
  } catch {
    return null;
  }
}

function write(area: StorageArea, key: string, value: string | null): void {
  try {
    if (value === null) window[area].removeItem(key);
    else window[area].setItem(key, value);
  } catch {}
}

export function createLocalStorageSyncStorage<T>(
  codec: StoredValueCodec<T>,
): SyncStorage<T> {
  return {
    getItem: (key, initialValue) =>
      codec.parse(read("localStorage", key), initialValue),
    setItem: (key, value) => write("localStorage", key, codec.serialize(value)),
    removeItem: (key) => write("localStorage", key, null),
  };
}

export function createTabScopedStorage<T>(
  codec: StoredValueCodec<T>,
  { persistInitialValue = false }: { persistInitialValue?: boolean } = {},
): SyncStorage<T> {
  const writeBoth = (key: string, value: string | null) => {
    write("sessionStorage", key, value);
    write("localStorage", key, value);
  };
  return {
    getItem: (key, initialValue) => {
      const value = codec.parse(
        read("sessionStorage", key) ?? read("localStorage", key),
        initialValue,
      );
      if (persistInitialValue) {
        write("sessionStorage", key, codec.serialize(value));
      }
      return value;
    },
    setItem: (key, value) => writeBoth(key, codec.serialize(value)),
    removeItem: (key) => writeBoth(key, null),
  };
}

export const rawStringLocalStorage = createLocalStorageSyncStorage<string>({
  parse: (storedValue, initialValue) => storedValue ?? initialValue,
  serialize: (value) => value,
});

export const booleanLocalStorage = createLocalStorageSyncStorage<boolean>({
  parse: (storedValue, initialValue) =>
    storedValue === "true" || (storedValue !== "false" && initialValue),
  serialize: String,
});

export function createJsonLocalStorage<T>(): SyncStorage<T> {
  return createLocalStorageSyncStorage<T>({
    parse: (storedValue, initialValue) => {
      if (storedValue === null) return initialValue;
      try {
        return JSON.parse(storedValue) as T;
      } catch {
        return initialValue;
      }
    },
    serialize: (value) => JSON.stringify(value),
  });
}

export function createBooleanPreferenceAtom(
  storageKey: string,
  defaultValue: boolean,
) {
  return atomWithStorage<boolean>(
    storageKey,
    defaultValue,
    createJsonLocalStorage<boolean>(),
    { getOnInit: true },
  );
}

export function createNullableLocalStorageEnumStorage<T extends string>(
  isValue: (value: string) => value is T,
): SyncStorage<T | null> {
  return createLocalStorageSyncStorage<T | null>({
    parse: (storedValue, initialValue) =>
      storedValue !== null && isValue(storedValue) ? storedValue : initialValue,
    serialize: (value) => value,
  });
}

export function createLocalStorageEnumStorage<T extends string>(
  isValue: (value: string) => value is T,
): SyncStorage<T> {
  return createNullableLocalStorageEnumStorage(isValue) as SyncStorage<T>;
}

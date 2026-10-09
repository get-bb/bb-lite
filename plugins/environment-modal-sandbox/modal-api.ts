export interface ModalCredentials {
  tokenId: string;
  tokenSecret: string;
}

export interface ModalSandboxSpec {
  appName: string;
  name: string;
  imageId: string;
  timeoutMs: number;
  cpu: number;
  memoryMiB: number;
  tags: Record<string, string>;
}

export interface ModalExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ModalExecOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ModalClient {
  accountIdentity(): Promise<string>;
  ensureImage(request: {
    appName: string;
    dockerfile: string;
    signal: AbortSignal;
    log?: (line: string) => void;
  }): Promise<string>;
  create(spec: ModalSandboxSpec): Promise<string>;
  running(sandboxId: string): Promise<boolean>;
  exec(
    sandboxId: string,
    command: string[],
    options?: ModalExecOptions,
  ): Promise<ModalExecResult>;
  snapshot(sandboxId: string): Promise<string>;
  terminate(sandboxId: string): Promise<void>;
  deleteSnapshot(imageId: string): Promise<void>;
}

export interface ModalApi {
  connect(credentials: ModalCredentials): ModalClient;
}

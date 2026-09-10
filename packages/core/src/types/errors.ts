/**
 * Recoverable CLI error classes — exported from core so every extension
 * package (tui, cli, meta-layer) handles provider/command failures the
 * same way. None of these are fatal: the host CLI catches them, renders
 * a message, and keeps running. Only a genuine FatalError may terminate
 * the process, and only from the entrypoint — never from inside core.
 */

/** Base class for errors a REPL/CLI can recover from. */
export class RecoverableCliError extends Error {
  /** Concrete action the user can take, rendered alongside the message. */
  readonly action: string;

  constructor(message: string, action = "") {
    super(message);
    this.name = "RecoverableCliError";
    this.action = action;
  }
}

/** Provider exists but its configuration is wrong or incomplete. */
export class ProviderConfigurationError extends RecoverableCliError {
  constructor(message: string, action = "") {
    super(message, action);
    this.name = "ProviderConfigurationError";
  }
}

/** A required credential for the target provider is not configured. */
export class MissingApiKeyError extends ProviderConfigurationError {
  readonly provider: string;

  constructor(provider: string) {
    super(`No API key configured for ${provider}`, `Use: /key ${provider} <your-api-key>`);
    this.name = "MissingApiKeyError";
    this.provider = provider;
  }
}

/** Provider slug is not in the registry. */
export class UnknownProviderError extends RecoverableCliError {
  readonly provider: string;

  constructor(provider: string) {
    super(`Unknown provider: ${provider}`);
    this.name = "UnknownProviderError";
    this.provider = provider;
  }
}

/** Raised by a provider factory when initialization fails (auth, network, config). */
export class ProviderInitializationError extends RecoverableCliError {
  constructor(message: string, action = "Check the API key and endpoint, then retry") {
    super(message, action);
    this.name = "ProviderInitializationError";
  }
}

/** Genuine irrecoverable failure — only the CLI entrypoint may act on this. */
export class FatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalError";
  }
}

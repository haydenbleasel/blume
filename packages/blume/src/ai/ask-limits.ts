/**
 * What one request to the assistant's generated route (`/api/ask`) may carry.
 * The route answers a longer conversation with a `400` (see
 * `askEndpointTemplate`), so the panel's client (`useAssistant`) sends only
 * the latest turns that fit. The endpoint is unauthenticated, so the limits
 * bound what one request can spend against the model.
 */

/** The most messages, questions and answers together, one request sends. */
export const ASK_MAX_MESSAGES = 40;

/** The most characters the messages take as JSON (`JSON.stringify`). */
export const ASK_MAX_MESSAGES_CHARS = 24_000;

// Ways to reach a customer outside a conversation: a Telegram bot the workspace connected, later
// an SMS provider. The CRM and the AI agent never import each other, so the code that owns a
// channel registers it here and the CRM asks by channel name.
//
// A sender is { reach, send, ready? }:
//   reach(workspaceId, people) → { [personId]: { address, language? } } for the people it can write
//     to; people are CRM customers ({ id, name, phone, telegram: the bare handle, "jasur_k" }). One call for the whole list.
//   send(address, text) → { ok: true } | { ok: false, code, retry }: `code` says why it didn't go
//     (blocked, channel_off, rate_limited, ...), `retry` whether trying again later may help.
//   ready(workspaceId) → whether it has a way out in this workspace at all (a Telegram bot that is
//     connected). Left out: it has one everywhere (a provider set up for the whole server).
// An SMS provider plugs in the same way: reach() answers for customers with a phone number.

const senders = new Map();

/** Adds a channel. Channels are tried in the order they were added, so add the free ones first. */
export const registerSender = (channel, sender) => senders.set(channel, sender);

/**
 * How each person can be reached: { [personId]: { channel, address, language } }. A person no
 * channel reaches is missing from the answer. A channel that fails to answer is passed over.
 */
export async function reach(workspaceId, people) {
  const out = {};
  for (const [channel, sender] of senders) {
    const left = people.filter((p) => !out[p.id]);
    if (!left.length) break;
    let found = {};
    try {
      found = (await sender.reach(workspaceId, left)) || {};
    } catch (e) {
      console.error(`Couldn't ask ${channel} who it reaches:`, e.message);
    }
    for (const p of left) if (found[p.id]?.address) out[p.id] = { channel, address: found[p.id].address, language: found[p.id].language || null };
  }
  return out;
}

/**
 * The channels that have a way out in this workspace, in the order they are tried: ["telegram"].
 * One that fails to answer is left out.
 */
export async function readyChannels(workspaceId) {
  const out = [];
  for (const [channel, sender] of senders) {
    try {
      if (!sender.ready || (await sender.ready(workspaceId))) out.push(channel);
    } catch (e) {
      console.error(`Couldn't ask ${channel} whether it is ready:`, e.message);
    }
  }
  return out;
}

/** Sends one text: { ok: true } or { ok: false, code, retry }. Never throws. */
export async function send(channel, address, text) {
  const sender = senders.get(channel);
  // This process has no such channel (it wasn't loaded here): another try may find it.
  if (!sender) return { ok: false, code: "no_sender", retry: true };
  try {
    const result = await sender.send(address, text);
    return result?.ok ? { ok: true } : { ok: false, code: result?.code || "send_error", retry: Boolean(result?.retry) };
  } catch (e) {
    console.error(`Sending by ${channel} failed:`, e.message);
    return { ok: false, code: "send_error", retry: true };
  }
}

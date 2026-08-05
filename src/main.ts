import { invoke } from "@tauri-apps/api/core";
import { marked } from "marked";
import "./style.css";

type CardContent =
  | { kind: "section"; title: string; body: string }
  | { kind: "cloze"; prompt: string; cloze: number }
  | { kind: "multiple-choice"; mode: "single" | "multiple"; question: string; answers: Answer[]; explanation?: string }
  | { kind: "code-gap"; language: string; prompt?: string; code: string; gaps: Record<string, Gap> };
type Answer = { id?: string; text: string; correct: boolean };
type Gap = { answer?: string; answers?: string[]; regex?: string; match?: { trim: boolean; normalize_whitespace: boolean; case_sensitive: boolean } };
type Card = { uid: string; section_uid: string; content: CardContent; review_count: number; deck_ids: number[]; due_deck_ids: number[]; due_without_deck: boolean };
type Deck = { id: number; name: string };
type Stats = { due_now: number; reviewed_today: number; streak_days: number; accuracy_week?: number };
type Snapshot = { protocol_version: number; generated_at: number; decks: Deck[]; cards: Card[]; statistics: Stats };
type ReviewEvent = { event_id: string; device_id: string; card_uid: string; reviewed_at: number; rating: number; answer_correct?: boolean; response_ms: number };
type PublicSettings = { owner: string; repo: string; branch: string; device_id: string; token_present: boolean };
type SyncResult = { snapshot: Snapshot; acknowledged_event_ids: string[] };

const app = document.querySelector<HTMLElement>("#app")!;
const AUTO_SYNC_MS = 5 * 60 * 1000;
let snapshot = load<Snapshot>("snapshot");
let pending = load<ReviewEvent[]>("pending") ?? [];
let reviewed = load<Record<string, number>>("reviewed") ?? {};
let settings: PublicSettings | null = null;
let view: "choose" | "review" | "complete" = "choose";
let queue: Card[] = [];
let activeDeckId: number | null = null;
let index = 0;
let revealed = false;
let selected = new Set<number>();
let gapAnswers: Record<string, string> = {};
let started = Date.now();
let lastSyncAt = 0;
let message = navigator.onLine ? "Ready to grow" : "Offline garden";
let syncing = false;
let setupError = "";

function load<T>(key: string): T | null {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") as T; } catch { return null; }
}

function persist() {
  localStorage.setItem("pending", JSON.stringify(pending));
  localStorage.setItem("reviewed", JSON.stringify(reviewed));
  if (snapshot) localStorage.setItem("snapshot", JSON.stringify(snapshot));
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]!);
}

function markdown(value: string, inline = false) {
  const parsed = inline ? marked.parseInline(value) : marked.parse(value);
  const document = new DOMParser().parseFromString(String(parsed), "text/html");
  document.querySelectorAll("script, style, iframe, object, embed, form, input, button").forEach(element => element.remove());
  document.querySelectorAll("*").forEach(element => {
    for (const attribute of [...element.attributes]) {
      if (attribute.name.startsWith("on") || !["href", "src", "alt", "title", "class"].includes(attribute.name)) element.removeAttribute(attribute.name);
    }
    for (const attribute of ["href", "src"]) {
      const target = element.getAttribute(attribute);
      if (target && !/^(https?:|mailto:|#|\/)/i.test(target)) element.removeAttribute(attribute);
    }
  });
  return document.body.innerHTML;
}

function noteBody(body: string) {
  return body
    .replace(/^\s{0,3}#{1,6}\s+.*(?:\r?\n|$)/, "")
    .replace(/^\s*```quiz[^\n]*\r?\n[\s\S]*?^\s*```\s*$/gm, "")
    .replace(/\s*\{#[\w-]+\}(?=\s*$)/gm, "")
    .trim();
}

function gapIsCorrect(gap: Gap | undefined, submitted: string) {
  if (!gap) return false;
  if (gap.regex) {
    try { if (new RegExp(gap.regex).test(submitted)) return true; } catch { /* Invalid regexes are rejected by yalive. */ }
  }
  const options = gap.match ?? { trim: true, normalize_whitespace: false, case_sensitive: true };
  const normalize = (value: string) => {
    if (options.trim) value = value.trim();
    if (options.normalize_whitespace) value = value.replace(/\s+/g, " ");
    return options.case_sensitive ? value : value.toLowerCase();
  };
  return [gap.answer, ...(gap.answers ?? [])].some(answer => answer != null && normalize(answer) === normalize(submitted));
}

function cardFace(card: Card) {
  const content = card.content;
  if (content.kind === "section") {
    return `<p class="eyebrow">Remember this section</p><h2>${markdown(content.title.replace(/\s*\{#[\w-]+\}\s*$/, ""), true)}</h2>${revealed ? `<div class="prose">${markdown(noteBody(content.body))}</div>` : `<p class="quiet">Bring the main idea to mind, then reveal.</p>`}`;
  }
  if (content.kind === "cloze") {
    const prompt = escapeHtml(content.prompt).replace(/\{\{c(\d+)::(.*?)(?:::(.*?))?\}\}/g, (_, number, answer, hint) =>
      Number(number) === content.cloze ? `<mark>${revealed ? answer : hint || "tap to reveal"}</mark>` : answer);
    return `<p class="eyebrow">Fill the thought</p><h2 class="prompt">${prompt}</h2>`;
  }
  if (content.kind === "multiple-choice") {
    const choices = content.answers.map((answer, answerIndex) => {
      const state = revealed ? (answer.correct ? " correct" : selected.has(answerIndex) ? " wrong" : "") : selected.has(answerIndex) ? " selected" : "";
      return `<button class="choice${state}" data-choice="${answerIndex}" ${revealed ? "disabled" : ""}><span>${String.fromCharCode(65 + answerIndex)}</span>${escapeHtml(answer.text)}</button>`;
    }).join("");
    return `<p class="eyebrow">Choose ${content.mode === "multiple" ? "all that fit" : "one answer"}</p><h2>${escapeHtml(content.question)}</h2><div class="choices">${choices}</div>${revealed && content.explanation ? `<div class="answer">${escapeHtml(content.explanation)}</div>` : ""}`;
  }
  const code = escapeHtml(content.code).replace(/\{\{gap:([\w-]+)\}\}/g, (_, name) => {
    const expected = content.gaps[name]?.answer ?? content.gaps[name]?.answers?.[0] ?? name;
    if (revealed) {
      const state = gapIsCorrect(content.gaps[name], gapAnswers[name] ?? "") ? "correct" : "wrong";
      return `<span class="gap-result ${state}" title="Your answer: ${escapeHtml(gapAnswers[name] ?? "")}">${escapeHtml(expected)}</span>`;
    }
    const size = Math.min(24, Math.max(4, expected.length));
    return `<input class="code-gap" data-gap="${escapeHtml(name)}" value="${escapeHtml(gapAnswers[name] ?? "")}" size="${size}" aria-label="Code gap ${escapeHtml(name)}" autocomplete="off" spellcheck="false">`;
  });
  return `<p class="eyebrow">Complete the code</p>${content.prompt ? `<h2>${escapeHtml(content.prompt)}</h2>` : ""}<pre><code>${code}</code></pre>`;
}

function render() {
  const card = queue[index];
  const stats = snapshot?.statistics;
  if (!settings?.token_present) {
    app.innerHTML = setupView();
    bindSetup();
    return;
  }
  if (snapshot && snapshot.protocol_version !== 2) {
    app.innerHTML = `<section class="shell"><header>${brand()}<button class="icon" id="settings">Reset</button></header><div class="complete"><div class="sun">!</div><p class="eyebrow">Update needed</p><h1>Sync from desktop.</h1><p>This phone needs a deck-aware snapshot. Update yalive and run desktop sync once.</p><button class="primary" id="sync">${syncing ? "Syncing..." : "Try sync again"}</button></div></section>`;
  } else if (!snapshot) {
    app.innerHTML = `<section class="shell"><header>${brand()}<button class="icon" id="settings">Reset</button></header><div class="complete"><div class="sun">Y</div><p class="eyebrow">Pocket garden</p><h1>Bring down your cards.</h1><p>${escapeHtml(message)}</p><button class="primary" id="sync">${syncing ? "Syncing..." : "Sync with GitHub"}</button></div></section>`;
  } else if (view === "choose") {
    app.innerHTML = deckChooser(stats);
  } else if (!card) {
    app.innerHTML = `<section class="shell"><header>${brand()}<button class="icon" id="settings">Reset</button></header><div class="complete"><div class="sun">Y</div><p class="eyebrow">Garden tended</p><h1>You showed up.</h1><p>${pending.length ? `${pending.length} review${pending.length === 1 ? " is" : "s are"} safe on this phone, waiting to sync.` : "This deck is resting."}</p><div class="complete-actions"><button class="primary" id="choose-deck">Choose another deck</button><button class="secondary" id="repeat-deck">Force review this deck</button><button class="text-button" id="sync">${syncing ? "Syncing..." : "Sync with GitHub"}</button></div></div>${dock(stats)}</section>`;
  } else {
    const revealLabel = card.content.kind === "code-gap" ? "Check answer" : "Reveal answer";
    app.innerHTML = `<section class="shell"><header>${brand()}<button class="sync-dot ${pending.length ? "waiting" : ""}" id="sync" aria-label="Sync">${syncing ? "..." : pending.length}</button></header><div class="progress"><i style="width:${Math.round(index / queue.length * 100)}%"></i></div><article class="card">${cardFace(card)}</article><div class="actions">${revealed ? ratingButtons() : `<button class="primary reveal" id="reveal">${revealLabel}</button>`}</div><footer><span>${index + 1} of ${queue.length}</span><span>${escapeHtml(message)}</span></footer></section>`;
  }
  bindMain();
}

function brand() { return `<div class="brand"><b>yReviewy</b><span>pocket garden</span></div>`; }
function dock(stats?: Stats) { return `<div class="dock"><div><b>${(stats?.reviewed_today ?? 0) + index}</b><span>today</span></div><div><b>${stats?.streak_days ?? 0}</b><span>day rhythm</span></div><div><b>${stats?.accuracy_week == null ? "-" : Math.round(stats.accuracy_week * 100) + "%"}</b><span>accuracy</span></div></div>`; }
function ratingButtons() { return `<div class="ratings"><button data-rate="1"><b>Again</b><span>1</span></button><button data-rate="2"><b>Hard</b><span>2</span></button><button data-rate="3"><b>Good</b><span>3</span></button><button data-rate="4"><b>Easy</b><span>4</span></button></div>`; }

function cardsForDeck(deckId: number | null) {
  return snapshot!.cards.filter(card => deckId === null ? card.deck_ids.length === 0 : card.deck_ids.includes(deckId));
}

function cardIsDue(card: Card, deckId: number | null) {
  return deckId === null ? card.due_without_deck : card.due_deck_ids.includes(deckId);
}

function deckChooser(stats?: Stats) {
  const groups: Array<{ id: number | null; name: string }> = [
    { id: null, name: "No deck" },
    ...snapshot!.decks.map(deck => ({ id: deck.id, name: deck.name })),
  ];
  const rows = groups.map(group => {
    const cards = cardsForDeck(group.id);
    const due = cards.filter(card => cardIsDue(card, group.id) && ((reviewed[card.uid] ?? 0) < snapshot!.generated_at)).length;
    const encoded = group.id ?? "none";
    return `<article class="deck-row"><div><h2>${escapeHtml(group.name)}</h2><p>${due} due / ${cards.length} total</p></div><div class="deck-actions"><button class="primary" data-deck="${encoded}" ${due ? "" : "disabled"}>Review due</button><button class="secondary" data-force-deck="${encoded}" ${cards.length ? "" : "disabled"}>Force all</button></div></article>`;
  }).join("");
  return `<section class="shell deck-shell"><header>${brand()}<button class="sync-dot ${pending.length ? "waiting" : ""}" id="sync" aria-label="Sync">${syncing ? "..." : pending.length}</button></header><main class="deck-picker"><p class="eyebrow">Choose what matters now</p><h1>Review a deck.</h1><p class="lede">Due review follows the schedule. Force all lets you study again before an exam.</p><div class="deck-list">${rows}</div></main>${dock(stats)}</section>`;
}

function startReview(deckId: number | null, force: boolean) {
  activeDeckId = deckId;
  queue = cardsForDeck(deckId).filter(card => force || (cardIsDue(card, deckId) && (reviewed[card.uid] ?? 0) < snapshot!.generated_at));
  index = 0;
  revealed = false;
  selected.clear();
  gapAnswers = {};
  started = Date.now();
  view = queue.length ? "review" : "complete";
  message = force ? "Focused review" : "Due review";
  render();
}

function setupView() {
  return `<section class="setup"><div class="seed">y</div><p class="eyebrow">Your knowledge, within reach</p><h1>Pair your pocket garden.</h1><p class="lede">Use a classic GitHub token to read your private vault and safely append reviews.</p><form id="setup-form"><label>Repository<input name="repository" placeholder="owner/repository or GitHub URL" value="${settings ? `${settings.owner}/${settings.repo}` : ""}" required /></label><label>Branch<input name="branch" value="${settings?.branch || "main"}" required /></label><label>Classic token<input name="token" type="password" placeholder="ghp_..." required /></label><p class="form-error" aria-live="polite">${escapeHtml(setupError)}</p><button class="primary">Pair and bloom</button></form><p class="fine">The token stays in Android app-private storage, never in the web view or review files.</p></section>`;
}

function parseRepository(value: string): [string, string] | null {
  const repository = value.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const match = repository.match(/^(?:https?:\/\/github\.com\/|git@github\.com:)?([^/\s:]+)\/([^/\s]+)$/i);
  return match ? [match[1], match[2]] : null;
}

function bindSetup() {
  document.querySelector("#setup-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const repository = parseRepository(String(data.get("repository")));
    if (!repository) {
      setupError = "Enter owner/repository or a github.com repository URL.";
      render();
      return;
    }
    const [owner, repo] = repository;
    setupError = "";
    const button = form.querySelector<HTMLButtonElement>("button");
    if (button) { button.disabled = true; button.textContent = "Pairing..."; }
    try {
      settings = await invoke("save_settings", { input: { owner, repo, branch: data.get("branch"), token: data.get("token") } });
      await sync();
    } catch (error) { setupError = String(error); render(); }
  });
}

function bindMain() {
  document.querySelector("#reveal")?.addEventListener("click", () => { revealed = true; render(); });
  document.querySelectorAll<HTMLElement>("[data-choice]").forEach(button => button.addEventListener("click", () => {
    const choice = Number(button.dataset.choice);
    const card = queue[index];
    if (card.content.kind === "multiple-choice" && card.content.mode === "single") selected.clear();
    selected.has(choice) ? selected.delete(choice) : selected.add(choice);
    render();
  }));
  document.querySelectorAll<HTMLInputElement>("[data-gap]").forEach(input => input.addEventListener("input", () => {
    gapAnswers[input.dataset.gap!] = input.value;
  }));
  document.querySelectorAll<HTMLElement>("[data-rate]").forEach(button => button.addEventListener("click", () => rate(Number(button.dataset.rate))));
  document.querySelector("#sync")?.addEventListener("click", sync);
  document.querySelector("#settings")?.addEventListener("click", async () => { await invoke("clear_settings"); settings = null; render(); });
  document.querySelectorAll<HTMLElement>("[data-deck]").forEach(button => button.addEventListener("click", () => startReview(button.dataset.deck === "none" ? null : Number(button.dataset.deck), false)));
  document.querySelectorAll<HTMLElement>("[data-force-deck]").forEach(button => button.addEventListener("click", () => startReview(button.dataset.forceDeck === "none" ? null : Number(button.dataset.forceDeck), true)));
  document.querySelector("#choose-deck")?.addEventListener("click", () => { view = "choose"; render(); });
  document.querySelector("#repeat-deck")?.addEventListener("click", () => startReview(activeDeckId, true));
}

function rate(rating: number) {
  const card = queue[index];
  let correct: boolean | undefined;
  if (card.content.kind === "multiple-choice") correct = card.content.answers.every((answer, i) => answer.correct === selected.has(i));
  if (card.content.kind === "code-gap") correct = Object.entries(card.content.gaps).every(([name, gap]) => gapIsCorrect(gap, gapAnswers[name] ?? ""));
  const now = Math.floor(Date.now() / 1000);
  pending.push({ event_id: `${settings!.device_id}-${now}-${crypto.randomUUID()}`, device_id: settings!.device_id, card_uid: card.uid, reviewed_at: now, rating, answer_correct: correct, response_ms: Date.now() - started });
  reviewed[card.uid] = now;
  index++;
  if (index >= queue.length) view = "complete";
  revealed = false;
  selected.clear();
  gapAnswers = {};
  started = Date.now();
  message = ["Let it return", "Good effort", "Memory strengthened", "Rooted deeply"][rating - 1];
  persist();
  render();
}

async function sync() {
  if (syncing) return;
  syncing = true; message = "Reaching GitHub..."; render();
  try {
    const result = await invoke<SyncResult>("sync_github", { pending });
    const acknowledged = new Set(result.acknowledged_event_ids);
    pending = pending.filter(event => !acknowledged.has(event.event_id));
    snapshot = result.snapshot;
    reviewed = Object.fromEntries(Object.entries(reviewed).filter(([, reviewedAt]) => reviewedAt >= snapshot!.generated_at));
    view = "choose"; queue = [];
    index = 0; revealed = false; selected.clear(); started = Date.now();
    gapAnswers = {};
    message = pending.length ? "Some reviews still waiting" : "Fresh from GitHub";
    persist();
  } catch (error) { message = `Offline: ${String(error)}`; }
  lastSyncAt = Date.now();
  syncing = false; render();
}

async function start() {
  try { settings = await invoke("public_settings"); } catch { settings = null; }
  render();
  window.setInterval(() => { if (settings?.token_present && navigator.onLine) void sync(); }, AUTO_SYNC_MS);
}

window.addEventListener("online", () => { if (pending.length) void sync(); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && settings?.token_present && navigator.onLine && Date.now() - lastSyncAt >= AUTO_SYNC_MS) void sync();
});
void start();

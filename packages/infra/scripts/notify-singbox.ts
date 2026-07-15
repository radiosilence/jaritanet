/* eslint-disable no-console -- a CLI script: console is its output channel */
// Posts every user's sing-box profile URL to Telegram in one owner-relayed
// message. Run by the singbox-notify local command, which only fires when a
// profile actually changed (its trigger is the combined profile hash). No-ops
// without Telegram creds. Owner-relayed: a bot can't cold-DM a handle, so the
// owner forwards each URL. Each URL is a tap-to-copy <code> block plus a
// copy_text inline-keyboard button (Bot API 7.11+) for one-tap clipboard.

type NotifyUser = { name: string; role: "admin" | "guest"; url: string };

const raw = process.env.VPN_NOTIFY_USERS;
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!raw || !token || !chatId) {
  console.log("sing-box notify: users or Telegram creds missing — skipping");
  process.exit(0);
}

const users: NotifyUser[] = JSON.parse(raw);

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const section = (title: string, role: NotifyUser["role"]) => {
  const rows = users.filter((u) => u.role === role);
  if (!rows.length) return [];
  return [
    `<b>${title}</b>`,
    ...rows.map((u) => `<b>${esc(u.name)}</b>\n<code>${esc(u.url)}</code>`),
    "",
  ];
};

const text = [
  "<b>sing-box profiles updated</b>",
  "",
  ...section("Admins", "admin"),
  ...section("Guests", "guest"),
  'Add/refresh as a Remote profile (auto-updates every device on "Update").',
  "Tap a URL or its Copy button to clipboard it. Keep these secret — the",
  "unguessable path is the only thing guarding each profile.",
].join("\n");

// One copy_text button per user so each URL is one tap to the clipboard.
const inlineKeyboard = users.map((u) => [
  { text: `Copy ${u.name}`, copy_text: { text: u.url } },
]);

const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: inlineKeyboard },
  }),
});

if (!res.ok) {
  console.error(
    `sing-box notify: Telegram failed ${res.status}`,
    await res.text(),
  );
  process.exit(1);
}
console.log(`sing-box notify: sent (${users.length} user(s))`);

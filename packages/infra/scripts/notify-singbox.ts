/* eslint-disable no-console -- a CLI script: console is its output channel */
// Posts the sing-box profile URL + a QR to Telegram. Run by the singbox-notify
// local command, which only fires when the profile actually changed (its
// trigger is the profile hash). No-ops without Telegram creds.
import QRCode from "qrcode";

const url = process.env.SINGBOX_URL;
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!url || !token || !chatId) {
  console.log("sing-box notify: URL or Telegram creds missing — skipping");
  process.exit(0);
}

const png = await QRCode.toBuffer(url, { margin: 2, scale: 8 });

const caption = [
  "sing-box profile updated",
  "",
  url,
  "",
  'Add/refresh as a Remote profile (auto-updates every device on "Update").',
  "Pick a location in the Groups tab. Scan the QR to onboard a phone.",
  "Keep this URL secret — the unguessable path is the only thing guarding it.",
].join("\n");

const form = new FormData();
form.set("chat_id", chatId);
form.set("caption", caption);
form.set("photo", new Blob([png], { type: "image/png" }), "singbox-qr.png");

const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
  body: form,
  method: "POST",
});

if (!res.ok) {
  console.error(
    `sing-box notify: Telegram failed ${res.status}`,
    await res.text(),
  );
  process.exit(1);
}
console.log("sing-box notify: sent");

# Share your computer's spare power

Your graphics card is probably doing nothing right now. This lets people pay you
to use it.

You do not need to understand any of it. Two installs and one command.

---

## What you need

- A computer with a graphics card (most gaming PCs and every Apple Silicon Mac)
- About 20 minutes, mostly waiting for downloads
- A Bitcoin SV wallet with a few cents in it

That's the whole list.

---

## Step 1 — Install Ollama

Ollama is the free program that actually runs the AI.

1. Go to **https://ollama.com** and install it like any other app.
2. Open a terminal (Command Prompt on Windows, Terminal on Mac) and type:

```
ollama pull llama3.1:8b
```

That downloads about 5 GB. Go and make a cup of tea.

*Smaller computer? Use `ollama pull llama3.2:3b` instead — about 2 GB.*

---

## Step 2 — Install the connector

This is what lets people on the internet reach your computer safely. It's free
and needs no account.

**Windows**
```
winget install --id Cloudflare.cloudflared
```

**Mac**
```
brew install cloudflared
```

---

## Step 3 — Set up

In the folder you downloaded, run:

```
npm install
npm run setup
```

It looks at your computer, works out which AI model fits, checks what other
people are charging, and suggests a price. Say yes.

It will show you a **provider ID** — a long string of letters and numbers. Send
about **10,000 satoshis** to it (that's a fraction of a cent).

That money is yours and stays yours. It covers the tiny cost of advertising
yourself, and it lets you refund buyers whatever their answers don't use.
Earnings top it back up.

---

## Step 4 — Start earning

```
npm start
```

That's it. You're listed. Leave the window open.

To stop, press **Ctrl+C** — your listing comes down straight away and nobody can
send you work until you start again.

---

## Things worth knowing

**Where does the money go?** Straight into your own wallet, per answer. Janus
never holds it and cannot take it.

**Back up `janus-node.json`.** It contains the private key to your earnings.
Lose it and the money is gone — there is no password reset, because there is no
account.

**Your address changes sometimes.** The free connector hands out a new address
when it reconnects. The node notices and re-advertises itself automatically.

**Your electricity isn't free.** You're selling compute for satoshis; on a big
card running constantly, check that what you earn beats what you're spending on
power. On a machine that's already switched on, it's close to free money.

**Nothing leaves your computer except answers.** The questions come in, the
answers go out. No files, no screen, no access to anything else.

---

## If something goes wrong

**"Ollama is not running"** — open the Ollama app and try again.

**"Nothing you have downloaded fits"** — your card is smaller than the model.
Run `ollama pull llama3.2:3b` and set up again.

**"Could not get a public address"** — Step 2 didn't finish. Install cloudflared
and try again.

**Nobody is buying** — you may be priced above everyone else, or there may just
be no demand right now. Run `npm run setup` again to re-check the going rate.

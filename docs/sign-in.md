# Powering the assistant: a Meta key or Sign in with ChatGPT

The app's assistant needs a language model. You choose which one powers
it, in the app's settings:

1. **Meta (the default).** Your own Meta Model API key. Meta offers no
   sign-in for its model API, so the key is the login.
2. **Sign in with ChatGPT.** Your ChatGPT account, using your ChatGPT
   plan's usage. You need an eligible plan, such as Plus or Pro.

Whichever you choose receives the case data the assistant reads: the text
of the messages you add and your chat. Every request asks the provider
not to store the response (`store: false`). The app never switches to the
other provider by itself. If the chosen one cannot answer, the assistant
says so and tells you how to fix it.

Start the app:

```sh
pnpm install
pnpm build
pnpm start   # http://127.0.0.1:5180
```

The assistant always runs on the live model you set up. There is no
recorded mode. Until you add a key or sign in, the chat and every step
that needs the model answer "The assistant needs a Meta Model API key or
Sign in with ChatGPT. Add one in Connections." with a link to Settings, and
nothing in your case changes. The schedule, Activity, Undo, Settings and
Delete case work without a model.

## Option 1: a Meta key

Either way below works. A key you enter in the app is used before one in
the environment.

**In the app.** Open settings, paste your Meta Model API key and save it.
The key goes to the app's server and stays there, in
`data/app-secrets.sqlite` (readable only by your user). The page never gets
it back. "Remove key" deletes it.

**In `.env.local`, through varlock.** Put the key in `.env.local` as
`MODEL_API_KEY` and start the app through varlock, which loads it into the
environment:

```sh
pnpm exec varlock run -- pnpm start
```

`.env.local` is ignored by git and found by the secret scan if it is ever
added.

Then pick a model in settings: Muse Spark 1.3 (the default, lower cost) or
Muse Wonder 1.0 (higher cost).

## Option 2: Sign in with ChatGPT

1. Open the app **in a browser on the same computer** that runs it, at
   `http://127.0.0.1:5180`.
2. In settings, choose "Continue with ChatGPT". A ChatGPT page opens.
3. Sign in, choose the workspace, name the app if asked, and allow it to
   use your ChatGPT plan.
4. ChatGPT sends the browser back to `http://127.0.0.1:5180/auth/callback`.
   The app finishes the sign-in and opens its page again. Settings shows
   your name and that plan usage is on.
5. Pick a model from the list your account offers.

The sign-in must finish on the computer that runs the app, because
ChatGPT returns to `127.0.0.1`, the app's own loopback address:

- **App on another computer you reach over SSH:** forward the same port
  first, then open `http://127.0.0.1:5180` in your local browser:

  ```sh
  ssh -L 5180:127.0.0.1:5180 <host>
  ```

- **From a phone over a private Tailscale address:** the sign-in cannot
  finish there, since the phone's `127.0.0.1` is the phone. Sign in once
  from the computer (or through the tunnel). After that, every device
  uses the stored connection.

If you did not allow plan usage, you stay signed in but the assistant
cannot use ChatGPT. Sign in again and allow it, or switch to Meta.

ChatGPT usage counts against your plan. See and manage it at
[ChatGPT settings, Usage](https://chatgpt.com/settings/usage). If this app
reaches its limit there, the assistant says so.

**Sign out** in settings ends the session with ChatGPT and deletes the
app's tokens. If ChatGPT does not confirm the sign-out, the app says so,
and you can also disconnect the app in ChatGPT settings.

If ChatGPT ends the session (for example, you disconnected the app in
ChatGPT settings), the app signs you out and the assistant tells you to
sign in again or switch to Meta.

## What the app keeps

`data/app-secrets.sqlite`, beside the case database, holds your Meta key,
the ChatGPT tokens, the provider and model choices, and an identifier for
this installation. It has mode 600, is written in one step, is never sent
to the browser or logged, and is ignored by git. Delete case does not
remove it, because these are app settings. Remove key and Sign out do.

For the design and its choices, see `docs/decisions/0010-providers.md`.

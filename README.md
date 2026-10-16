# Local AI Chat

A small, local ChatGPT-style chat UI for an OpenAI-compatible model server. Chats stay on this machine in SQLite; only chat requests go to the configured model server.

## Requirements and setup

- Node.js 18 or newer
- Copy `.env.example` to `.env` and paste your key into `LLM_API_KEY`.
- From the project root, run `npm install && npm start`.
- Open `http://127.0.0.1:3000`. Later, run `npm start`.

The app also opens without `.env` or a key; sending then reports the missing key.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLM_BASE_URL` | `http://172.31.8.100:9005/v1/chat/completions` | OpenAI-compatible chat endpoint |
| `LLM_API_KEY` | empty | Sent only as `x-api-key` from the server |
| `DEFAULT_MODEL` | `qwen3-coder-next-sd-dev` | Initial model |
| `SYSTEM_PROMPT` | concise coding assistant | System message for each request |
| `TEMPERATURE` | `0.1` | Sampling temperature |
| `REQUEST_TIMEOUT_SECONDS` | `1500` | Model request timeout |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Local web server address |
| `DB_PATH` | `./data/chats.db` | SQLite database file |

## Files and data

- `server.js` - web server, API routes, model request, and browser bundle.
- `db.js` - SQLite schema, helpers, and persistence.
- `app.jsx` - React UI and client behavior.
- `style.css` - all app styling.
- `package.json` - dependencies and commands.
- `.env.example` - local configuration template.
- `.gitignore` - excludes local dependencies, secrets, and data.
- `README.md` - setup and project notes.

Data is stored in `data/chats.db`, ignored by git. Delete that file to reset local chats and saved models.

## Adding a feature

Add a server endpoint in the matching section of `server.js`, a small persistence helper in `db.js` if needed, and UI/components in `app.jsx`; style it in `style.css`.

## Troubleshooting

- `401` / `403`: check `LLM_API_KEY` and that the server accepts the required `x-api-key` header.
- `Could not reach`: check `LLM_BASE_URL`, network access, and VPN connectivity.
- `This chat is too long`: start a new chat; history is intentionally never trimmed.
- Port already in use: change `PORT` in `.env`.
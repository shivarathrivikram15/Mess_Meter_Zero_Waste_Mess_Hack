# MessMeter v4: zero-waste mess management

Students skip a meal up to 6 hours ahead; the kitchen cooks only what will be eaten; supervisors log waste and surplus; surplus above 15 kg alerts an NGO.

## Run locally
Requires **Node.js 22.13 or newer** (uses the built-in `node:sqlite`). No npm packages are needed.

```bash
npm test      # 39 unit + API integration tests
npm start     # http://localhost:3000
```
Open **http://localhost:3000** (not `index.html` directly).

### Demo accounts (seeded on first run)
| Role | Username | Password |
|---|---|---|
| Student | `aarav` (also `diya`, `kabir`) | `student123` |
| Supervisor | `supervisor` | `supervisor123` |

### Configuration (environment variables)
| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `MESSMETER_DB` | `data/messmeter.sqlite` | SQLite file |
| `MESSMETER_STUDENT_PASSWORD` / `MESSMETER_SUPERVISOR_PASSWORD` | demo values above | Passwords used when the database is first created |
| `MESSMETER_SECRET` | random, stored in the DB | Token signing key |
| `MESSMETER_TZ` | `Asia/Kolkata` | Campus timezone used for meal times and cutoffs |
| `MESSMETER_DEMO` | `1` | Set to `0` in production: disables the demo clock, simulation and reset endpoints |

## Architecture
| File | Role |
|---|---|
| `index.html`, `style.css`, `script.js` | Responsive, accessible frontend. Holds no business rules; every action goes through the API. |
| `logic.js` | Pure business rules shared by server and browser (cutoff, scaling, validation, forecast, CSV safety). |
| `data.js` | Menu and seeded history, shared so the server validates against exactly what students see. |
| `app.mjs` | HTTP app: routing, authentication, role checks, validation, security headers. Exported as a factory for tests. |
| `auth.mjs` | scrypt password hashing, HS256 signed tokens, login rate limiter (node:crypto only). |
| `db.mjs` | SQLite schema, prepared statements, transactions. |
| `server.mjs` | Entry point (env config, graceful shutdown). |
| `tests/` | `logic`, `auth` and `api` test suites (`node --test`). |

## Security model
- **Authentication:** username/password (scrypt, per-user salt) → 8-hour HS256 token sent as `Authorization: Bearer`. Login is rate-limited (8 attempts / 5 min per IP + username) and does not reveal whether a username exists.
- **Role-based access control:** `student` can opt out, rate, comment and vote (once). `supervisor` can log waste, run simulations, change the demo clock, view the audit trail and NGO ledger, and export CSV. Supervisor-only data is never sent to students.
- **Server-side cutoff and clock:** the 6-hour rule is evaluated on the server against the server's campus clock. Clients cannot supply a time. Supervisors may freeze a *demo clock* (audited, applies to everyone, disabled with `MESSMETER_DEMO=0`).
- **Input validation:** every endpoint validates day/meal against the real menu, kg values, ratings (1–5, real dishes), comment length, JSON content type and a 100 KB body limit. All dynamic text is HTML-escaped on render.
- **Hardening:** only five public static files are served (server code, tests and the DB are not reachable); CSP, `X-Frame-Options`, `nosniff`, `no-referrer`, `no-store`; CSV export neutralises spreadsheet formula injection.

## Reliability
SQLite (WAL mode, foreign keys) replaces the single JSON file. Multi-step changes (waste log + NGO alert + audit entry, rating + comment, voting) run in transactions, and one-vote-per-student is enforced by a primary key, so concurrent requests cannot double-count. State lives in the database, so restarts lose nothing, and the signing secret is persisted so sessions survive restarts.

## API
`POST /api/login` · `GET /api/state` · `POST /api/optout` · `POST /api/ratings` · `POST /api/vote` · `POST /api/logs` (supervisor) · `POST /api/simulate`, `POST /api/reset`, `PUT /api/demo-clock` (supervisor, demo mode) · `GET /api/export/logs.csv` (supervisor) · `GET /api/health`. Every mutating call returns the fresh state.

## Business rules
- Opt-outs close exactly six hours before the meal (server-checked).
- Kitchen quantity = (enrolled − opt-outs) × grams per student × 1.05 safety margin.
- Surplus above 15 kg triggers the NGO beacon; it is stored in the NGO ledger.
- **Smart prep forecast:** a least-squares trend over 14 days of opt-outs predicts tomorrow's skips and a pre-cook quantity.
- **Impact metrics:** rescued surplus is converted to approximate meals (0.4 kg per plate) and CO₂e avoided (2.5 kg per kg of food); both are stated assumptions.

## Known limits
Single campus, seeded enrolment of 50, in-memory login throttling (resets on restart), and Chart.js / fonts load from CDNs. For multi-instance deployment, move throttling to a shared store and serve over HTTPS.

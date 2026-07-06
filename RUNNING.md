# Running Reservly

Reservly has four surfaces served by one Express server (port **4646**):

| Surface | Path | Who |
|---|---|---|
| Booking Desk (admin SPA) | `/` | Store staff / managers |
| Staff mobile app (PWA) | `/m` | Floor staff on phones |
| Storefront booking widget | `/proxy/*` (via Shopify App Proxy) | Customers on the shop |
| Customer e-signature | `/sign/:token` | Customers on their phone |

The server binds to **all network interfaces**, so it's reachable from other
devices (phones, tablets) on the same network via the machine's LAN IP.

## Two ways to run

### 1. Production / demo — one port, reachable from any device (recommended)

```bash
cd apps/booking
npm run serve        # builds both SPAs, then serves everything on :4646
```

Then open, from **any device on the same Wi‑Fi**:

- Booking Desk: `http://<this-machine-LAN-IP>:4646`
- Staff app: `http://<this-machine-LAN-IP>:4646/m`

Find the LAN IP with `ipconfig getifaddr en0` (macOS) — e.g. `192.168.1.73`.
On this machine, `localhost:4646` works too.

Rebuild (`npm run serve` again) after code changes — this mode serves the
**built** app, so edits don't hot-reload here.

### 2. Development — hot reload, also LAN-reachable

```bash
cd apps/booking
npm run dev          # server :4646 + admin :5646 + mobile :5647, all hot-reloading
```

The Vite dev servers now bind to `0.0.0.0`, so you can hot-reload from a phone:

- Admin: `http://<LAN-IP>:5646`
- Staff app: `http://<LAN-IP>:5647`

(Vite proxies `/api`, `/sign`, `/print` to the server on 4646.)

## Installing the staff app on Android

1. Run one of the modes above and open the staff URL (`…/m` on 4646, or `:5647`)
   in Chrome on the phone.
2. Chrome menu (⋮) → **Add to Home screen** → **Install**.
3. It launches full-screen with the Reservly icon, offline shell, and the
   5‑minute battery standby.

For access outside the local network, put the server behind a public HTTPS host
or tunnel (see DEPLOYMENT.md) and install from that URL instead.

## Sign-ins

- **Staff** (Booking Desk + mobile): the staff password set in Settings.
- **Super admin** (Tenants page): `serge@onyourx.com` — reset with
  `node scripts/set-platform-password.mjs '<new password>'`.

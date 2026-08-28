# ⚡ SOLSCALP

> **High-Performance Autonomous Solana DEX Scalping Bot, 6-Layer Deterministic Safety Gate, AI Survival Classifier & Real-Time Terminal Cyberdeck.**

[![Solana](https://img.shields.io/badge/Solana-Mainnet-9945FF?logo=solana&logoColor=white)](https://solana.com)
[![Engine](https://img.shields.io/badge/Engine-Paper%20%7C%20Real%20Live-orange)]()
[![Jupiter API](https://img.shields.io/badge/DEX-Jupiter%20v1%20Swap-brightgreen)](https://jup.ag)
[![MEV Protection](https://img.shields.io/badge/MEV-Jito%20Bundles-blue)](https://jito.wtf)
[![Machine Learning](https://img.shields.io/badge/AI-Online%20SGD%20Classifier-blueviolet)]()
[![Tests](https://img.shields.io/badge/Tests-840%20Passed-success)]()
[![Node](https://img.shields.io/badge/Node.js-%3E%3D20-green?logo=node.js)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## 🌟 Overview

**SOLSCALP** is an end-to-end algorithmic trading system built specifically for the ultra-fast Solana ecosystem. It combines a **fail-closed, 6-layer on-chain safety gate** with **automated momentum screening**, **dip-buying / re-entry tracking**, an **online Machine Learning scam predictor**, a **React/Ink-powered terminal dashboard**, and **Jupiter + Jito MEV execution**.

```
                           ┌─────────────────────────────────┐
                           │      DexScreener / Gecko / RPC  │
                           └────────────────┬────────────────┘
                                            │
                                  [ Stream & Filter ]
                                            ▼
                           ┌─────────────────────────────────┐
                           │     6-Layer Safety Gate (L0-L5) │
                           │  • Mint / Freeze Authority      │
                           │  • Sell Simulation (Honeypot)   │
                           │  • Liquidity Lock & Pool Burn   │
                           │  • Top 10 Holder Concentration  │
                           │  • Deployer & Rug History       │
                           └────────────────┬────────────────┘
                                            │
                                     [ SAFE? == true ]
                                            ▼
                           ┌─────────────────────────────────┐
                           │    Strategy & AI Classification │
                           │  • Volume Acceleration & Break  │
                           │  • Online SGD Scam Predictor    │
                           │  • Round-Trip Cost Model        │
                           └────────────────┬────────────────┘
                                            │
                                    [ ENTER? == true ]
                                            ▼
                  ┌─────────────────────────┴─────────────────────────┐
                  ▼                                                   ▼
       ┌─────────────────────┐                             ┌─────────────────────┐
       │   🟡 PAPER MODE     │                             │   🔴 REAL LIVE MODE │
       │  • Real-Time Sim    │                             │  • Keypair Signer   │
       │  • Slippage & Fees  │                             │  • Jupiter Lite v1  │
       │  • Persistent Book  │                             │  • Jito MEV Bundles │
       └──────────┬──────────┘                             └──────────┬──────────┘
                  │                                                   │
                  └─────────────────────────┬─────────────────────────┘
                                            ▼
                           ┌─────────────────────────────────┐
                           │   🖥️ Interactive Ink Dashboard  │
                           │   📱 1:1 Telegram Remote Menu   │
                           └─────────────────────────────────┘
```

---

## ✨ Key Features

### 🛡️ 1. Six-Layer Deterministic Safety Gate
Price prediction is hard; on-chain scam detection is deterministic. Every token is vetted through 6 independent layers before any SOL is risked:
* **Layer 0 (Mint & Freeze):** Verifies `mintAuthority` and `freezeAuthority` are permanently revoked, and inspects Token-2022 extensions (transfer fees, confidential transfers).
* **Layer 1 (Sell Simulation):** Simulates buy and sell routing via Jupiter to detect honeypots, artificial transfer restrictions, and hidden sell taxes.
* **Layer 2 (Liquidity & LP Burn):** Confirms liquidity pool tokens are burned (sent to `1111..` or dead address) or permanently locked.
* **Layer 3 (Holder Concentration):** Pulls largest accounts to ensure top 10 non-AMM holders own $< 15\%$ of circulating supply.
* **Layer 4 (Deployer Reputation):** Traces creator wallet history and flags repeat scam deployers.
* **Layer 5 (Third-Party RugCheck):** Cross-references RugCheck risk score.

---

### 🖥️ 2. Terminal Cyberdeck Dashboard (`npm run dash`)
Built with React and Ink, providing 5 real-time monitoring tabs with an ultra-lean 10MB RAM footprint:

```
SOLSCALP  ⠋  [M] 🟡 PAPER  recording · 2s ago · next in 3s  profile early · reads 1

1 LIVE  2 POSITIONS  3 HISTORY  4 EVIDENCE  5 RE-ENTRY  · arrows · enter details · m mode switch · / search · q quit
╭──────────────────────────────────────────────────────────────────────────────────────────────────╮
│ 4532 scans over 15.2h · 688 found something the gate passed                                      │
│ · SCANNED THIS TICK 16 pairs · 6 cleared the screen · page 1/6                                   │
│   TOKEN      SAFE?    ENTER? MCAP      LIQ       5m      1h       ACC   B/S   AGE                │
│ ▶ Sue        passed   enter  $458,506  $75,747   +12.3%  +48.0%   1.6   2.1   45m                │
│   GTA        blocked  —      $957k     $94k      market cap above ceiling 750000                 │
│   MEMELORD   blocked  —      $17,293   $10,260   ↳ the safety gate: layer1-sellsim               │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
Live Book Equity: $481.98  (Cash: $481.98)  P&L: +$31.98  (3W / 0L)  0 open
```

* **Tab 1 (`LIVE`):** Real-time scanner feed, pass/block funnel, and instant safety diagnostics.
* **Tab 2 (`POSITIONS`):** Active holdings, unrealized P&L, mark price timeline, take-profit / stop-loss levels.
* **Tab 3 (`HISTORY`):** Complete catalogue of all 1,800+ tokens scanned today, entry vs current liquidity, trace curves, and outcomes.
* **Tab 4 (`EVIDENCE`):** Online SGD Machine Learning brain metrics, accuracy curves, and scam predictor weights.
* **Tab 5 (`RE-ENTRY`):** Dip-buying tracker for high-conviction tokens that experienced healthy pullbacks.

---

### 🔄 3. Instant Paper / Real Live Mode Switching
Switch effortlessly between simulation and real on-chain trading:
* **Interactive Toggle:** Press **`m`** in the dashboard to toggle mode.
* **Safety Confirmation:** Switching to live trading requires explicit **`[Y]`** confirmation and verifies wallet configuration.
* **Live Engine:** Uses **Jupiter Lite Swap v1 API** for optimal routing and **Jito MEV Bundles** to eliminate sandwich attacks.
* **Telegram Integration:** On-chain fills automatically push instant alerts with direct **Solscan** transaction links.

---

### 🧠 4. Machine Learning Scam Classifier (`TokenSurvivalModel`)
* Uses **Online Stochastic Gradient Descent (SGD)** with L2 regularization.
* Extracts 12 multidimensional feature vectors (liquidity-to-mcap ratio, volume acceleration, buy/sell ratios, slippage impacts).
* Pre-train or evaluate anytime via `npm run ml:train`.

---

## ⚡ RPC Infrastructure: Helius Mainnet

SOLSCALP is built and optimized for **[Helius](https://helius.dev)** as its primary Solana RPC provider:

* **Why Helius:** Public Solana RPC nodes aggressively rate-limit `getTokenLargestAccounts` and Token-2022 extension lookups, causing fail-closed safety checks to reject valid tokens. Helius provides high-throughput, low-latency infrastructure purpose-built for Solana DEX trading.
* **Cost-Effective Architecture:** Operates with peak performance on Helius's free/developer tier (1,000,000 free monthly credits) — **no $500/mo enterprise add-ons required**.
* **Dual Streaming Engine:**
  1. **High-Speed HTTP/WSS Radar (Default & Recommended):** Scans trending DEX pairs and runs the 6-layer safety gate every 1–2 seconds.
  2. **Yellowstone Geyser gRPC (Optional):** Plug-and-play support for Helius LaserStream / Triton gRPC validator streams for sub-millisecond block interception.

---

## 🚀 Quick Start

### 1. Prerequisites
* **Node.js**: v20.0.0 or higher.
* **Helius API Key**: Create a free account at [helius.dev](https://helius.dev) to get your dedicated RPC endpoint.

### 2. Installation & Test Suite
```bash
# Clone the repository
git clone https://github.com/matteo6134/solscalp.git
cd solscalp

# Install dependencies
npm install

# Run the full test suite (840+ unit & integration tests)
npm test
```

### 3. Environment Configuration
Create your `.env` file from the provided example:
```bash
cp .env.example .env
```

Configure your `.env` with your Helius endpoint:
```env
# Primary High-Speed RPC Endpoint (Helius)
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY
SOLANA_RPC_URL_FALLBACK=https://api.mainnet-beta.solana.com

# Yellowstone Geyser gRPC (Optional for institutional sub-millisecond streaming)
SOLANA_GRPC_URL=https://grpc.helius-rpc.com
SOLANA_GRPC_TOKEN=YOUR_HELIUS_API_KEY

# Telegram Alerts & Remote Control (Optional)
TELEGRAM_BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ
TELEGRAM_CHAT_ID=987654321

# Live Trading Keypair (Required only when executing real on-chain swaps)
SOLANA_PRIVATE_KEY=your_base58_private_key_or_json_byte_array
```

---

## 📱 Telegram Remote Command Center

Control and inspect your bot from your smartphone with full 1:1 dashboard mirroring:

| Command | Description |
|---|---|
| `/status` | Complete system health, book equity, cash, uptime, and funnel statistics. |
| `/live` | View candidates currently clearing the momentum screen. |
| `/positions` | List open positions with live marks and P&L percentages. |
| `/history` | Recent trade history and win/loss breakdown. |
| `/evidence` | Ground-truth safety gate validation statistics and AI accuracy. |
| `/reentry` | Dip-buying candidates and pullback tracking. |
| `/mode` | Display active trading mode (Paper vs. Live) and connected wallet. |
| `/check <mint>` | Run the full 6-layer safety gate on any Solana mint on demand. |
| `/pause` / `/resume` | Silence or re-enable alert notifications. |

---

## 💻 Running SOLSCALP

### Option A: Interactive Dashboard (Recommended)
```bash
npm run dash
```
* Use `1`–`5` to switch tabs.
* Use `↑`/`↓` arrows to navigate lists and `Enter` for detail drill-down.
* Press `m` to toggle between **Paper Simulation** and **Real Live Trading**.
* Press `s` to force a live DexScreener rescan on any highlighted token.
* Press `/` to search and filter tokens.
* Press `q` to safely exit.

### Option B: Autonomous Background Bot Daemon
```bash
npm run bot -- --early --paper
```

### Option C: Safety Gate Verification Tool
Inspect any token on the Solana network directly from your CLI:
```bash
npm run check EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

---

## ⌨️ Dashboard Keyboard Shortcuts

| Key | Action |
|:---:|---|
| **`1` - `5`** | Switch views (`1: Live`, `2: Positions`, `3: History`, `4: Evidence`, `5: Re-Entry`) |
| **`m`** | Toggle Trading Mode (**`Paper Simulation`** $\leftrightarrow$ **`Real Live Execution`**) |
| **`Enter`** | Open detailed token audit and breakdown panel |
| **`s`** | Instant live DexScreener rescan for the selected token |
| **`/`** | Open interactive search / filter box |
| **`g`** | Cycle group filter in History tab (`all` / `passed` / `survived` / `rugged`) |
| **`t`** | Cycle timeframe window (`1h` / `4h` / `24h`) |
| **`r`** | Force instant disk journal reload |
| **`Esc`** | Close detail panel / Clear search filter |
| **`q`** | Gracefully quit dashboard |

---

## 📁 Repository Structure

```
solscalp/
├── data/                    # Persistent storage (records, journals, trade mode)
│   ├── paper/               # Daily paper trade journal (.jsonl)
│   ├── recordings/          # Continuous market ticks for AI training (.jsonl)
│   ├── ml_weights.json      # Trained AI survival model weights
│   └── trade_mode.json      # Active mode flag (paper / real)
├── scripts/                 # CLI entry points and daemons
│   ├── bot.js               # Autonomous trading engine & Telegram listener
│   ├── dash.js              # React/Ink interactive terminal UI
│   ├── radar.js             # High-frequency DEX streaming radar
│   ├── record.js            # Market data recorder
│   └── train-ml.js          # Machine learning pre-training script
├── src/                     # Core system modules
│   ├── config.js            # Strategy parameters, risk ceilings, and constants
│   ├── data/                # DexScreener, GeckoTerminal, and Jupiter data clients
│   ├── evidence/            # Ground-truth outcome labeller and verification
│   ├── ml/                  # Online SGD TokenSurvivalModel & feature extractor
│   ├── notify/              # Telegram formatting and transmission
│   ├── paper/               # Portfolio accounting, cost models, and journal
│   ├── rpc/                 # Solana RPC client, priority fees, and Jito bundles
│   ├── safety/              # 6-Layer Deterministic Safety Gate (L0 - L5)
│   └── trade/               # Wallet manager, Jupiter swap, and mode switch
└── tests/                   # 840+ unit and integration tests (Vitest)
```

---

## ⚠️ Disclaimer

This software is for educational, research, and algorithmic trading development purposes only. Trading cryptocurrencies and low-liquidity Solana DEX tokens carries substantial financial risk. Never trade with money you cannot afford to lose. Always verify contracts and exercise appropriate risk management.

---

## 📄 License

Distributed under the MIT License. See [LICENSE](LICENSE) for more details.

# EloCoin technical architecture: chain, token standard, verified-compute minting, anti-gaming, tokenomics, security (as of Oct 2026)

Context for the report writer: according to this repo's README, Tokenelo is a **local** tracker. It has adapters for Claude Code, Codex and configured local inference, and it stores usage metadata and counts. UCU is a "secondary, versioned compute-measurement feature under review" that "does not establish ... token issuance, redemption, or a financial return" (/home/user/Tokenelo/README.md; docs/licensing.md says "EloCoin is a separate product pursuit and is not part of the tracker launch"). This shapes everything below. The logs Tokenelo reads are on the user's machine, so the user can edit them. On their own they cannot be a basis for minting. Any minting design needs an anchor outside the user's control: the provider, a TEE, or a proof.

Research-method note: WebFetch could not resolve DNS for most primary-doc domains in this session (docs.chain.link, sherlock.xyz, zealynx.io, akash.network, epoch.ai, know.rendernetwork.com). Many findings therefore rest on search-result summaries of those pages. Where a figure comes from a secondary or vendor source, it is flagged.

---

## 1. Chain choice: Ethereum L1 vs L2s (Base, Arbitrum, Optimism) vs Solana; cross-chain (LayerZero OFT, CCIP, ERC-7802)

### Takeaway
For a small team in late 2026, an EVM L2 (Base first) is the lowest-risk default. Fees are cents or less, the EVM tooling and audit pool are the deepest (Solidity audits run about 20–30% cheaper than Rust), Base leads on token launches, and Base fits the Coinbase ecosystem. Solana is the main alternative: the cheapest fees and the most trading volume, plus Token-2022 extensions. Ship single-chain first. If you go multichain later, use a burn/mint standard (ERC-7802 / CCIP CCT / OFT) with **multi-verifier** security. The April 2026 KelpDAO loss of about $292M came from a 1-of-1 LayerZero DVN configuration.

### Cited Findings
**Fees and cost**
- After Fusaka (Dec 2025), the typical Ethereum L1 base fee is under 1 gwei. An example swap on Base costs about $0.003 in total, and the L1 data portion (about $0.0027) is most of that (rough estimates at ETH ≈ $2,000). — [ethskills gas guide](https://skills.sh/austintgriffith/ethskills/gas)
- A mid-2026 L2 comparison gives average fees of about $0.05 per transaction on Base, about $0.09 on Arbitrum One and OP Mainnet, and about $0.07 on zkSync Era. The spread between the cheapest and most expensive major L2 is "only a few cents for most operations". Single source, unconfirmed. — [Ryder L2 comparison 2026](https://ryder.id/blogs/post/ethereum-l2s-in-2026-arbitrum-vs-optimism-vs-base-vs-zksync); [Spark L2 fee war](https://www.spark.money/research/ethereum-l2-rollup-fee-war-dynamics). Note: the search summary did not say which of these two pages holds the median-fee figures.
- Fusaka added a blob-fee floor tied to the L1 execution base fee, so L2 data costs can no longer fall to near zero. Sources disagree on the exact ratio. — [Spark EIP-4844 blob fee market](https://www.spark.money/research/ethereum-eip-4844-blob-fee-market)
- Solana transactions average about $0.00025. — [Backpack Learn: Solana vs Base](https://learn.backpack.exchange/zh-cn/articles/solana-vs-base)

**Liquidity and launch activity**
- Dune data reported by The Block shows Base overtook Solana in daily token launches for the first time on July 24, 2025, driven largely by Zora creator coins. Solana still led on trading volume of launched tokens. — [The Block](https://www.theblock.co/post/365384/base-solana-zora)
- A January 2026 snapshot puts Base at $1.826B daily DEX volume, $462M perps volume and $9.156B DeFi TVL. The source is a promotional piece, so treat it with caution. — [MEXC news](https://www.mexc.com/cs-CZ/news/759442)
- A Base–Solana bridge was announced in Oct 2025, with code still on testnet at that time. — [TechCabal](https://techcabal.com/2025/10/01/base-and-solana-bridge/)

**Dev and audit cost**
- Solidity audits are generally 20–30% cheaper than Rust (Solana) or Move audits. — [Zealynx audit pricing 2026](https://www.zealynx.io/blogs/audit-pricing-2026)

**Solana token standard (Token-2022)**
- Extensions need the Token-2022 program and **must be chosen at mint creation; they cannot be added later**. Transfer hooks store a hook program ID plus an update authority. — [Solana docs: token extensions](https://solana.com/developers/guides/token-extensions/getting-started); [QuickNode transfer hooks](https://www.quicknode.com/pt/guides/solana-development/spl-tokens/token-2022/transfer-hooks)
- The mint authority can be a multisig, and it can be revoked once minting is finished to enforce a hard cap. The permanent-delegate extension can transfer or burn from any account. A pause extension can halt all transfers, mints and burns. These are high-privilege authorities. — [madeonsol](https://madeonsol.com/blog/solana-token-extensions-explained); [Spark: token extensions](https://www.spark.money/research/solana-token-extensions-payments)

**Cross-chain**
- LayerZero's OFT is reported at about 87% of cross-chain transfer volume. There are 733+ OFTs, including USDT0 and PYUSD. The security model is configurable: each app chooses how many DVNs must verify a message. — [CryptoBriefing](https://cryptobriefing.com/layerzero-oft-cross-chain-dominance/); [Eco LayerZero 2026 guide](https://eco.com/support/en/articles/13714024-layerzero-architecture-and-zro-2026-guide)
- **KelpDAO exploit, Apr 18, 2026:** attackers poisoned the RPC nodes behind a LayerZero DVN, then DDoS'd the healthy nodes. The DVN failed over to the poisoned infrastructure, and the OFTAdapter released 116,500 rsETH (about $292M). A second packet for 40,000 rsETH was blocked by Kelp's emergency multisig. — [Blockaid](https://www.blockaid.io/blog/how-a-single-layerzero-dvn-compromise-drained-292m-from-kelpdao). LayerZero attributes the exploit to DPRK/Lazarus (TraderTraitor) and blames Kelp's single-DVN setup. It says it will stop signing 1/1 DVN messages. — [LayerZero statement](https://layerzero.network/blog/kelpdao-incident-statement). Kelp says 1-of-1 "is the configuration documented in LayerZero's documentation and shipped as the default for any new OFT deployment". — [CoinDesk](https://www.coindesk.com/tech/2026/04/20/kelp-dao-claims-layerzero-s-default-settings-are-what-actually-caused-the-usd290-million-disaster); [The Block](https://www.theblock.co/post/398204/kelp-dao-shifts-blame-layerzero)
- After the hack, more than $3B in TVL reportedly migrated to Chainlink CCIP (Kelp, Solv, Re, Lido). Kraken chose CCIP as the exclusive provider for kBTC. — [Whale Alert](https://whale-alert.io/stories/d0b40186a7b400/Kraken-drops-LayerZero-adopts-Chainlink-CCIP-as-exclusive-crosschain-provider-for-kBTC-and-future-wrapped-tokens-after-Kelp-DAO-exploit). BitGo reportedly moved WBTC (about $7.3B) from OFT to CCIP. — [Midas (Turkish)](https://www.getmidas.com/midasin-kulaklari/layerzerodan-chainlink-ccipye-73-milyar-dolarlik-wbtc-gecisi-zincirler-arasi-rekabeti-kizistirdi-p-661273)
- CCIP's Cross-Chain Token (CCT) standard lets issuers run their own burn-mint or lock-release pools, with a separate Risk Management Network. It is more gated, covers fewer chains, and tends to cost more and settle slower than permissionless rivals. This comes from a guide written by a CCIP contributor. — [Protofire](https://protofire.io/guides/cross-chain-messaging/)
- ERC-7802 defines `crosschainMint`/`crosschainBurn` and is bridge-agnostic. SuperchainERC20 is Optimism's implementation of it. OpenZeppelin ships `ERC20Bridgeable` for ERC-7802 compatibility. — [ERC-7802](https://ercs.ethereum.org/ERCS/erc-7802); [OpenZeppelin ERC20 API](https://docs.openzeppelin.com/contracts/api/token/erc20). Optimism's docs conflict on readiness: one page says SuperchainERC20 is "ready for production deployments", while the OP Stack interop upgrade it needs is "still in active development". — [Optimism compatible tokens](https://docs.optimism.io/interop/compatible-tokens); [Optimism SuperchainERC20](https://docs.optimism.io/stack/interop/superchain-erc20)

### Inferences
- **Recommended default: Base, an ERC-20 inheriting OpenZeppelin `ERC20Bridgeable` (ERC-7802)**, so a bridge can be added later without migrating the token. Reasons:
  - mint and claim transactions cost cents or less;
  - Coinbase and the Superchain sit next to Base;
  - EAS is available on Base (see §2/§5);
  - the cheaper and larger Solidity audit market.
- Arbitrum and OP Mainnet are near-equivalent technically. The choice among L2s is mainly about ecosystem and BD, not cost.
- **Ethereum L1** is now cheap enough for occasional admin and governance transactions, but not for per-user claim flows at scale. Use it only if the token's credibility requires L1 issuance.
- **Solana** makes sense if the target users and liquidity live there. Its costs: Rust/Anchor development, about 20–30% more for audits, and extension choices that are frozen at mint creation.
- **Cross-chain:** do not launch multichain on day one. If you expand, use burn/mint (not lock/release) and **never use a single verifier**. Either CCIP CCT, or OFT with a ≥2-of-N DVN set including at least one independent DVN, plus per-chain rate limits and an emergency pause multisig. The Kelp incident shows that a fast emergency multisig can stop a second malicious packet.

### Gaps
- No primary 2026 source was retrieved on exchange-listing requirements (Coinbase, Binance), or on whether Base vs Solana materially changes listing odds.
- Current Base interop (Superchain) live status was not confirmed.
- No head-to-head independent security audit of OFT vs CCIP was found.
- No verified 2026 Solana DEX-volume figure for direct comparison.

---

## 2. Verifying off-chain AI usage/compute before minting (provider usage APIs, zkTLS, TEEs, zkML, oracles, EigenLayer AVS, EAS; what Bittensor/Gensyn/io.net/Grass do)

### Takeaway
Nothing in 2026 cryptographically proves that "user X consumed N tokens of Claude or GPT" without trusting the provider. Closed-model usage can only be anchored to **provider-reported data**: Anthropic and OpenAI org-level Admin usage APIs, optionally carried on-chain via an oracle/attestor or zkTLS. **TEEs** (Intel TDX + NVIDIA H100/H200 CC) are production-grade for **self-hosted/local inference**, but physical attacks (TEE.fail, Oct 2025) can extract attestation keys, and the operator who owns the hardware is exactly the attacker in a mint-for-usage system. **zkML** reached GPT-2/Gemma-3-scale full inference in 2025–26 but is not practical for frontier LLM volumes. Peer networks (Bittensor, Gensyn, io.net, Chutes) use validator re-checking, benchmarks, re-execution and, increasingly, TEEs, not zk.

### Cited Findings
**Provider usage APIs (most practical anchor for Claude/OpenAI usage)**
- **Anthropic Usage & Cost Admin API** (`/v1/organizations/usage_report/messages`):
  - token counts: uncached input, cached input, cache creation, output;
  - buckets: 1m, 1h or 1d;
  - group or filter by API key, workspace, model, service tier or context window;
  - needs an admin key (`sk-ant-admin01-…`);
  - "unavailable for individual accounts", so an organization is required;
  - Claude Enterprise orgs use a separate Enterprise Analytics API.
  — [Anthropic Usage & Cost API docs](https://platform.claude.com/docs/en/build-with-claude/usage-cost-api)
- **Anthropic Claude Code Analytics API** (`/v1/organizations/usage_report/claude_code`):
  - one record per user per day, covering sessions, lines of code, commits, PRs, tool usage, and tokens and cost by model;
  - admin key required;
  - up to 1-hour delay;
  - not available on Claude Platform on AWS.
  — [Anthropic Claude Code Analytics API](https://platform.claude.com/docs/en/build-with-claude/claude-code-analytics-api). A third party says it covers only first-party API usage, not Bedrock or Vertex. — [minware](https://www.minware.com/blog/how-to-get-reporting-data-out-of-claude-code)
- **OpenAI**:
  - `/v1/organization/usage/completions` gives input, output, cached and audio tokens, request counts, and model, project, user and API-key IDs;
  - `/v1/organization/costs` gives line-item costs in daily buckets;
  - both need an `sk-admin-` key created by an org Owner.
  — [OpenAI Cookbook: Completions Usage API](https://developers.openai.com/cookbook/examples/completions_usage_api); [Coralogix integration](https://coralogix.com/docs/integrations/ai-observability/openai/api-platform/)

**zkTLS (prove an HTTPS response came from a given server)**
- TLSNotary uses MPC-TLS plus notarization and selective disclosure; its lineage dates to 2013. Reclaim uses a proxy-witness (attestor) model, which is faster but weaker than full MPC. Opacity builds on TLSNotary with committee proving, on-chain verification and slashing of notaries (also described as MPC+TEE). zkPass uses VOLE ZK. DECO is licensed by Chainlink. — [BlockEden zkTLS (Jan 2026)](https://blockeden.xyz/blog/2026/01/13/zktls-verifiable-web-data-zero-knowledge-proofs/); [BlockEden zkTLS (Feb 2026)](https://blockeden.xyz/es/blog/2026/02/23/zktls-verifiable-offchain-data-https/)
- In production in 2026, 3Jane uses Reclaim zkTLS to pull FICO scores for undercollateralized lending. — [BlockEden zkTLS (Feb 2026)](https://blockeden.xyz/es/blog/2026/02/23/zktls-verifiable-offchain-data-https/). Nearly all zkTLS coverage found here comes from a single secondary blog.

**TEEs (CPU TDX/SEV-SNP + NVIDIA GPU CC)**
- Each H100 has a device-unique key certified by NVIDIA's CA. The GPU measures its firmware and signs the measurement. Verification runs offline or via NVIDIA's NRAS, which returns a JWT. The Python Attestation SDK is deprecated in favor of the C++ SDK and CLI. — [NVIDIA Hopper attestation example](https://docs.nvidia.com/attestation/quick-start-guide/latest/attestation-examples/hopper_single_gpu.html); [Edgeless H100 wiki](https://www.edgeless.systems/wiki/hardware/nvidia-hopper-h100)
- Intel Trust Authority supports composite CPU-TEE + NVIDIA GPU attestation for up to 8 GPUs per request. — [Intel Trust Authority](https://docs.trustauthority.intel.com/main/articles/concept-gpu-attestation.html)
- A GCP study of TDX + H100 found the attestation flows work, but firmware trust anchors are opaque and quote signing concentrates trust in the vendors. — [Census Labs PDF](https://census-labs.com/static/media/uploads/blog/challenging_the_boundaries_of_cc.pdf)
- **TEE.fail (Oct 2025):** a DDR5 memory-interposition attack using under $1,000 of equipment breaks Intel SGX/TDX and AMD SEV-SNP. It can extract attestation keys from fully patched machines, and those keys "can be used to compromise Nvidia's GPU Confidential Computing". It needs physical access and root. Intel and AMD say physical attacks are out of scope of their threat model. — [The Hacker News](https://thehackernews.com/2025/10/new-teefail-side-channel-attack.html); [SecurityWeek](https://securityweek.com/new-attack-targets-ddr5-memory-to-steal-keys-from-intel-and-amd-tees)
- **Phala:** GPU TEE inference (vLLM behind an OpenAI-compatible API) with TDX quote and NVIDIA verification. It claims an ECDSA signature suffices for on-chain verification, which is "cheaper than ZK", and 95–99% of native performance (vendor claim). It supports TDX, SGX, SEV and H100/H200. dstack is a TEE SDK built by Phala and Flashbots. — [Phala GPU TEE docs](https://docs.phala.network/overview/phala-network/gpu-tee); [Phala deployment guide](https://docs.phala.com/phala-cloud/confidential-ai/gpu-tee-deployment-guide); [Phala dstack](https://phala.com/dstack); [Phala learn](https://phala.com/learn/Private-Compute-Cloud-Guide)
- **EigenCloud (mainnet alpha, Oct 2025):**
  - EigenAI is deterministic LLM inference on H100s; anyone with the same hardware can re-execute and detect divergence; stake and slashing are "planned".
  - EigenCompute runs Docker images in a TEE and returns an attestation; cryptoeconomic and ZK verification are "future".
  — [EigenCloud blog](https://blog.eigencloud.xyz/eigencloud-brings-verifiable-ai-to-mass-market-with-eigenai-and-eigencompute-launches/); [SiliconANGLE](https://siliconangle.com/2025/10/01/eigencloud-launches-platform-verifiable-ai-infrastructure/)

**zkML / verifiable inference**
- Lagrange DeepProve-1 proved full GPT-2 inference (Aug 2025). — [Lagrange DeepProve-1](https://lagrange.dev/blog/deepprove-1). Gemma-3 has been proven end-to-end, Llama-class is "still in development", and the stack was open-sourced on Jun 3, 2026, with more than 12M proofs generated over the past year (press release). — [Lagrange open source](https://lagrange.dev/blog/deepprove-is-now-open-source)
- Lagrange claims 54–158x faster proving than EZKL. This is a vendor benchmark. — [Lagrange announcement](https://lagrange.dev/blog/announcing-deepprove-zkml)
- IACR ePrint 2026/1112 presents full multi-token LLM inference verification by certifying the output sequence. — [IACR ePrint 2026/1112](https://eprint.iacr.org/2026/1112)
- A GPT-2 forward pass is over 100M multiplications, which is the root of the proving cost. — [arXiv 2603.18046](https://arxiv.org/html/2603.18046v1)

**Oracles / AVS / attestations**
- **Chainlink Functions is sunset on September 1, 2026.** Subscriptions must move to the Chainlink Runtime Environment (CRE). — [Chainlink Functions app](https://functions.chain.link/mainnet); [Functions playground notice](https://functions.chain.link/playground/13f3c115-e8b2-4eca-9c59-275f03e3b310). CRE was unveiled at SmartCon in Oct 2024 (early access then) as a modular, multi-DON "microservices-like" framework. — [The Block](https://www.theblock.co/post/323672/chainlink-upgrade)
- **EigenLayer slashing:**
  - testnet slashing went live Dec 19, 2024 — [Cointelegraph](https://cointelegraph.com/news/eigen-layer-slashing-testnet-live);
  - production slashing was activated on mainnet Apr 17, 2026 (secondary source) — [BlockEden](https://blockeden.xyz/blog/2026/04/18/eigenlayer-avs-slashing-activation-15b-restaking-reality-check/);
  - official announcement — [EigenCloud blog](https://blog.eigencloud.xyz/slashing-goes-live/);
  - AVSs define Operator Sets with Unique Stake Allocation; ELIP-006 Redistributable Slashing is on mainnet. — [EigenLayer Operator Sets docs](https://docs.eigencloud.xyz/eigenlayer/concepts/operator-sets/operator-sets-concept)
- **EAS:** anyone registers a schema in SchemaRegistry and attests via the EAS contract. — [EAS contracts](https://github.com/smartcontracts/eas-contracts). Offchain attestations are EIP-712-signed blobs. — [ERC-8176 draft](https://eips.ethereum.org/EIPS/eip-8176). Base is cited at about $0.002 per on-chain attestation (non-authoritative package README). — [socket.dev @cellar-door/eas](https://socket.dev/npm/package/@cellar-door/eas)

**What comparable networks use**
- **Bittensor:**
  - Yuma Consensus distributes each subnet's alpha to the owner, miners, validators and stakers every tempo, based on validator weight-setting, i.e. subjective scoring rather than cryptographic proof;
  - the first halving was Dec 2025, to 0.5 TAO per block (about 3,600 TAO/day).
  — [Bittensor emissions docs](https://www.bittensor.com/docs/concepts/emissions). dTAO (Feb 2025) gave each subnet an alpha token in a TAO AMM pool. "Taoflow" (Nov 2025) routes emissions by net TAO staking flows. — [FalconX](https://falconx.io/newsroom/state-of-bittensor-subnet-adoption-trends-network-mechanics-and-covenants-departure)
- **Chutes (Bittensor SN64):** GraVal GPU proofs, plus "adversarial validation" where several miners answer the same query. — [Asymmetric Jump](https://asymmetricjump.substack.com/p/bittensor-subnet-research-chutes). Its top assurance tier uses Intel TDX + NVIDIA. — [Chutes security docs](https://chutes.ai/docs/core-concepts/security-architecture). A mid-2026 ecosystem update reports the whole platform moved to TEE (search-summary claim). Rewards are based on 7-day cumulative compute time. — [wikidocs guide](https://wikidocs.net/blog/@jaehong/24261/)
- **Gensyn:** Verde ("refereed delegation") resolves disputes by bisection between trainers. RepOps makes the computation deterministic. It needs at least one honest, non-colluding trainer. The EVM referee is "future work". — [Verde paper, arXiv 2502.19405](https://arxiv.org/pdf/2502.19405). Judge is a verifiable evaluation framework built on Verde (Aug 2025). — [Gensyn testnet](https://www.gensyn.ai/testnet). The $AI token sale (3% of supply) ran on Sonar in Dec 2025. — [DL News/PR](https://www.dlnews.com/external/gensyn-launches-ai-token-sale-on-sonar). Mainnet reportedly launched Apr 22, 2026, with exchange listing on Apr 29 (secondary source). — [cryptonews.net](https://cryptonews.net/news/altcoins/32805418/)
- **io.net:**
  - hourly proof-of-work puzzle to confirm the hardware is genuine — [io.net PoW docs](https://docs.io.net/docs/proof-of-work);
  - TFLOPS and memory-bandwidth benchmarks every 60 seconds per GPU, with low scorers removed and users refunded — [io.net FAQ](https://io.net/p/faq-how-does-io-net-ensure-gpu-performance);
  - NVIDIA CC attestation for H200 confidential VMs — [io.net CC attestation guide](https://io.net/docs/guides/clouds/confidential-compute-attestation-guide);
  - zkGPU-ID with NovaNet, announced Nov 2024, production status unknown — [DePIN Hub](https://9o1hbtdj3x.depinhub.io/news/io-net-and-nova-net-launch-zk-gpu-id-for-trusted-gpu-resources-in-decentralized-infrastructure-20099).
- **Grass:** nodes, routers and validators. Validators batch session data and produce ZK proofs of it, which go to a Solana-settled data rollup ("Data Ledger") for provenance. Most sources are secondary or old. — [DL News](https://dlnews.com/articles/defi/ai-training-network-grass-picks-solana-for-layer-2-rollup/); [Alea Research](https://alearesearch.substack.com/p/grass-what-you-need-to-know)

### Inferences
**Maturity matrix for EloCoin (Oct 2026):**

| Evidence type | What it proves | Trust assumption | Maturity | EloCoin fit |
|---|---|---|---|---|
| Provider Admin usage API (Anthropic, OpenAI) pulled by EloCoin attestor | Org X's API/Claude Code usage per day/user/model | Provider honest + attestor honest + admin key custody | Production | **Primary anchor (Tier A)**. Org-only, no individual accounts. |
| Same data via zkTLS (Reclaim/TLSNotary/Opacity) | The response really came from api.anthropic.com / api.openai.com | zkTLS notary/witness model | Early production | Optional upgrade: lets users prove usage without handing over admin keys. |
| Chainlink CRE / custom oracle DON fetching usage API | Several nodes agree on the API response | DON + secrets handling | CRE replacing Functions in 2026 | Decentralizes the attestor step. Do **not** build on Functions (sunset Sep 1, 2026). |
| TEE attestation (TDX + H100/H200 CC) for self-hosted/local inference | This code ran on genuine CC hardware with these measurements | Intel/NVIDIA roots; no physical attacker | Production (Phala, Chutes, io.net, EigenCompute alpha) | **Tier B**, for local/self-hosted inference only. Discount or cap it because of TEE.fail-class physical attacks. |
| Deterministic re-execution / refereed delegation (EigenAI, Gensyn Verde) | Output matches an honest re-run | ≥1 honest re-executor; deterministic kernels | Alpha / early mainnet | Spot-check audits of open-model usage claims, not per-claim. |
| zkML (DeepProve, EZKL) | This model produced this output | Cryptographic | GPT-2/Gemma-3 scale; Llama-class pending | **Immature** for LLM-scale usage; impossible for closed models. Watch only. |
| Local Tokenelo logs (Claude Code/Codex JSONL) | Nothing on their own | User honesty | n/a | **Tier C**: display/reporting only. Do not mint, or mint only against Tier A corroboration. |
| EAS attestations | A given attester signed a claim | Attester key | Production | Good **transport/audit format** for per-epoch UCU claims (on-chain hash, off-chain body). |

- Attestation pipeline recommended for MVP:
  1. The user or org links a provider org via OAuth-less admin-key delegation or a zkTLS session.
  2. The EloCoin attestor service (later a CRE workflow or AVS) pulls daily usage.
  3. It normalizes to UCU using a versioned definition.
  4. It signs an EIP-712 claim or EAS offchain attestation per account per epoch.
  5. It posts one Merkle root per epoch on-chain.
  6. Users claim after a challenge window.
- An EigenLayer AVS is overkill for an MVP. It adds operator recruitment and slashing design. Revisit it once the economic value per epoch justifies decentralized attestors.
- A core limitation: Claude Pro/Max and ChatGPT subscription usage (what many Claude Code/Codex users run on) is **not** exposed through these Admin APIs, which are org- or API-scoped. EloCoin cannot verify most individual-subscriber usage today except via zkTLS against a logged-in web dashboard, which is fragile and may conflict with provider ToS.

### Gaps
- CRE general-availability status, supported chains, pricing and HTTP/secrets limits could not be retrieved (docs.chain.link unreachable).
- No primary documentation was retrieved on whether Anthropic or OpenAI usage endpoints carry any **signature** that third parties can verify. Assume they do not, so the attestor or zkTLS layer must add it.
- The provider ToS position on sharing admin-API data or zkTLS-scraping usage dashboards for token rewards was not researched (legal workstream).
- GraVal internals and Grass's current proof flow are not documented in primary sources found.
- EigenAI slashing status after alpha is unknown.

---

## 3. Sybil resistance and gaming: fake/inflated usage, identity, rate limits, staking/slashing

### Takeaway
The hard problem is the economics, not identity. If the token value minted per UCU exceeds the marginal cost of producing that UCU, people will wash-trade compute: buy cheap tokens, loop agents, or exploit flat-rate subscriptions. **Invariant: reward per UCU < cheapest marginal cost to generate that UCU**, enforced by:
- minting against verified **spend**, not raw tokens;
- per-epoch global and per-account caps;
- a challenge window with clawback;
- identity at the org or human level (KYC/KYB for large claimants; Human Passport or World ID for retail).

### Cited Findings
- **Human Passport** (formerly Gitcoin Passport; acquired by Holonym in Dec 2024 and rebranded in Feb 2025) aggregates "stamps" (government ID, phone, on-chain activity) into a score. — [Decrypt](https://decrypt.co/305249/holonym-foundation-acquires-gitcoin-passport-to-onboard-its-2m-users-to-create-worlds-largest-proof-of-humanity-solution); [Human Passport llms.txt](https://passport.human.tech/llms.txt). It self-reports 9 consecutive Gitcoin rounds defended and, as of Mar 2026, 120+ projects, 150+ campaigns and over $512M of capital flow secured. It is evaluating a KYC provider (Onfido), and Identity Staking and NFC-passport features are in progress. — [Human Passport blog](https://passport.human.tech/blog/human-passport-proof-of-personhood-and-sybil-resistance-for-web3)
- **World ID / World Chain:** an OP-Stack L2 with native World ID, gas allowances and priority mempool for verified humans, and about 2s blocks. — [Cointelegraph](https://cointelegraph.com/news/worldcoin-launches-layer-2-network-world-chain). Verified-user counts conflict: about 5.8M Orb-verified in one source, about 25M on the network (Feb 2025) and about 33M World App users (Sep 2025) in another. — [The Grid profile](https://thegrid.id/profiles/world). Orb Mini ships in 2026. Several countries have restricted or banned Orb operations. — [DEXTools World Chain guide](https://www.dextools.io/tutorials/what-is-world-chain-worldcoin-l2-guide-2026-pt)
- Patterns in comparable networks:
  - io.net removes underperforming providers and refunds users. — [io.net FAQ](https://io.net/p/faq-how-does-io-net-ensure-gpu-performance)
  - Chutes cross-checks several miners on the same query to catch miners not running the claimed model. — [Asymmetric Jump](https://asymmetricjump.substack.com/p/bittensor-subnet-research-chutes)
  - EigenLayer Operator Sets add stake-backed slashing (mainnet 2026), with redistribution of slashed funds possible via ELIP-006. — [EigenLayer docs](https://docs.eigencloud.xyz/eigenlayer/concepts/operator-sets/operator-sets-concept)
- The Bittensor critique: stake-weighted validation meant "a far smaller group of validators effectively directed emissions", which motivated dTAO. — [FalconX](https://falconx.io/newsroom/state-of-bittensor-subnet-adoption-trends-network-mechanics-and-covenants-departure)
- LLM prices at constant performance fall fast (see §4). The cheapest models make raw token counts cheap to generate, so a raw-token-based mint is trivially gameable. — [Epoch AI price trends](https://epoch.ai/data-insights/llm-inference-price-trends)

### Inferences (design controls, ranked by leverage)
1. **Mint against verified USD spend (or UCU normalized by spend), never raw token counts.** Set the mint rate so the expected token value per $1 of verified spend is well below $1 (for example a 1–5% "rebate"). Then wash usage is unprofitable, because the attacker pays the provider more than they receive. Monitor DEX price and auto-adjust the rate (see §4).
2. **Exclude or heavily discount flat-rate subscription usage**: the marginal cost of usage is near zero up to the limits. Also exclude any source without a provider-side anchor, such as local logs (Tier C) and local inference without TEE (cost is the user's own electricity, which cannot be verified).
3. **Identity layering:**
   - KYB/KYC above a per-epoch threshold, which also helps with regulatory posture;
   - one provider org ID maps to one claimant (dedupe on Anthropic/OpenAI org ID and API-key IDs);
   - Human Passport score threshold or World ID for small retail claims;
   - prefer Human Passport's multi-stamp model over a single biometric because of World ID's regulatory exposure.
4. **Optimistic minting**:
   - the per-epoch Merkle root sits in a challenge window (for example 3–7 days);
   - claims vest linearly (for example 30–90 days), so fraud found later can be clawed back from unvested balances;
   - a bonded challenger role (optional later).
5. **Rate limits and caps**:
   - global per-epoch mint cap enforced in the contract;
   - per-account cap;
   - anomaly detection on usage spikes and model mix (for example sudden shifts to the cheapest model, or perfectly regular request cadence).
6. **Staking/slashing for attestors, not users**, at first. User staking adds friction. Stake makes most sense for decentralized attestors (an AVS) later.

### Gaps
- No public data found on Sybil or fraud rates for usage-reward ("proof of spend") programs specifically.
- No 2026 official World ID verified-user count.
- No source on provider rules prohibiting resale or reward-linking of usage data.

---

## 4. Tokenomics for a compute-unit token: fixed vs elastic supply, emissions, BME, work-token, redeemability, stable-value; keeping 1 UCU meaningful as compute deflates

### Takeaway
The three live compute-network precedents all **separate a stable-value usage credit from a volatile, capped work/governance token**, connected by burn-and-mint:
- Helium: Data Credits at $0.00001, created only by burning HNT;
- Render: USD-priced jobs paid by burning RENDER, with a declining emission schedule;
- Akash: BME live since Mar 23, 2026. AKT is burned for USD-pegged, non-transferable ACT, and providers are paid in freshly minted AKT at a 30-minute TWAP, with collateral-ratio circuit breakers.

Because the price of equivalent LLM output falls roughly 10x+/year (Epoch: 9x–900x/yr by task; a 2026 report says about 13x/yr), **UCU must be defined against a slowly-deflating physical or price index** (H100-equivalent GPU-hours or FLOPs, or a USD spend basis) and **versioned**. It must not be pegged to model tokens.

### Cited Findings
**Burn-and-mint precedents**
- **Helium:**
  - Data Credits are pegged at $0.00001 ($1 = 100,000 DC) and can only be created by burning HNT at the oracle USD price — [TokenInsight](https://tokeninsight.com/en/coins/helium/overview);
  - HIP-20 set two-year halvings and a 223M max supply;
  - "Net Emissions" re-mint burned HNT up to about 1,643.84 HNT per epoch.
  — [Helium docs: tokens](https://docs.helium.com/tokens/). Reportedly HNT market cap fell about 86% in a year and Helium Mobile was sold in spring 2026 (single French-language source, unverified). — [Journal du Coin](https://journalducoin.com/?p=806987)
- **Render:**
  - BME approved by vote in 2022 and implemented in 2023;
  - creators pay for jobs and the RENDER is burned on completion;
  - emissions follow a declining schedule, with max supply raised from about 536.87M to 644.25M (about 107.38M emitted over 10 years);
  - year 2 is about 5.90M RENDER, of which the Foundation accrues 2.90M.
  — [Render knowledge base BME](https://know.rendernetwork.com/basics/burn-mint-equilibrium); [Render Foundation monthly report (Jul 2025)](https://rendernetwork.medium.com/render-network-foundation-monthly-report-24e14ea50e13). A 5% fee whose USD value is burned is reported only by an aggregator. — [MEXC tokenomics](https://www.mexc.com/de-DE/price/RENDER/tokenomics)
- **Akash AEP-76 BME:**
  - live on mainnet Mar 23, 2026 — [API Evangelist](https://blogs.apievangelist.com/blogs/akash-2026-03-18-what-burn-mint-equilibrium-means-for-akash/); [defi.tech AKT report](https://www.defi.tech/files/AKT%20Report_20260528.pdf);
  - tenants burn AKT at the oracle price to mint **non-transferable USD-pegged ACT** (for example about 877 AKT for 1,000 ACT at $1.14);
  - at settlement, the consumed ACT is burned and fresh AKT is minted to providers at the current price;
  - 30-minute TWAP from the on-chain x/oracle module (AEP-80), with staleness and deviation checks;
  - AKT/USD fed via Pyth (AEP-81).
  — [Akash BME blog](https://akash.network/blog/what-burn-mint-equilibrium-means-for-akash/); [AEP-76](https://akash.network/roadmap/aep-76/); [AEP-81](https://akash.network/roadmap/aep-81/)
  - Circuit breakers: a halt state blocks new AKT→ACT minting while settlements continue. — [Akash testnet circuit-breaker plan](https://akash.network/docs/testnet/testplan/circuit-breaker). A third-party blog says a 95% collateral ratio triggers a warning and 90% a halt (unverified). — [Crypto Community News](https://cryptocommunitynews.substack.com/p/akash-networks-bme-testnet-begins)
  - Results so far: as of late May 2026 the vault collateral ratio was 2.29, with about 264,210 AKT (about $237K) burned cumulatively. — [defi.tech AKT report](https://www.defi.tech/files/AKT%20Report_20260528.pdf). Net burn rose from about 5,950 to about 11,105 AKT/day by late July, but issuance roughly offset it, leaving net supply about flat. — [DEV: AKT inflation analysis Jul 2026](https://dev.to/mrnasdog/akt-inflation-analysis-july-2026-a-lower-mint-still-ahead-of-the-burn-1fk6). Sources conflict on whether providers receive AKT or a non-transferable settlement credit. — [Crypto Community News](https://cryptocommunitynews.substack.com/p/akash-networks-bme-testnet-begins)
- **Bittensor (fixed-cap emission model):** 21M cap logic, halvings triggered by issuance thresholds, and recycled (burned) registration TAO re-emitted, which pushes halvings out. The first halving was Dec 2025. — [Bittensor emissions docs](https://www.bittensor.com/docs/concepts/emissions); [Staking Rewards](https://www.stakingrewards.com/asset/bittensor)
- **Gensyn $AI:** reported 10B total supply with a 12-month team and investor cliff (aggregator, unverified). — [yellow.com](https://yellow.com/417.html/asset/ai)

**Compute-cost deflation and price indices**
- Epoch AI finds that LLM inference prices at constant performance fall 9x–900x/year depending on the milestone (median about 50x/yr per secondary coverage). It cautions that the fastest drops are recent and may not persist. — [Epoch AI](https://epoch.ai/data-insights/llm-inference-price-trends). A Sep 22, 2026 Epoch report ("The plunging price of thought") reportedly finds 47%/quarter, about 13x/yr, since 2023 (secondary source). — [Pillitteri summary](https://pasqualepillitteri.it/en/news/21044/epoch-ai-ai-prices-fall-47-percent-quarter)
- An independent estimate puts the decline at 5–10x/yr for frontier models at fixed benchmark performance, with algorithmic efficiency about 3x/yr after controlling for hardware. — [arXiv 2511.23455](https://arxiv.org/html/2511.23455v1)
- **CME and Silicon Data compute futures:**
  - announced Aug 11, 2026 for an Oct 5, 2026 launch (pending regulatory review);
  - GPU1 is cash-settled on the monthly average of the Silicon Data H100 Rental Index;
  - 1 contract = 730 GPU-hours, quoted in $/GPU-hour, with a $0.01 tick worth $7.30.
  — [CME press release](https://www.cmegroup.com/media-room/press-releases/2026/8/11/cme_group_and_silicondatatolaunchcomputefuturesonoctober5tounloc.html); [Silicon Data guide](https://www.silicondata.com/blog/practitioners-guide-compute-future-hedge-step-by-step)
  - ICE and Ornn announced a rival transaction-based index (May 19, 2026). The same H100 rents for about $2.74/hr on neo-clouds and $7.20/hr at hyperscalers. — [Spheron](https://www.spheron.network/blog/compute-futures-cme-gpu-contracts-ai-buyers/)

### Inferences
**Options compared:**

| Design | Pros | Cons | Fit |
|---|---|---|---|
| Fixed cap + declining emissions distributed pro rata to verified UCU each epoch (Bittensor/Helium-style "emission pool") | Simple; minting is bounded no matter how much usage is gamed; supply story is easy to audit | Reward per UCU swings with usage volume; does not track compute value | **Best MVP**: caps total exposure to verification failures |
| Elastic mint per UCU at a fixed rate | Directly "backed" by usage narrative | Unbounded supply; fully exposed to gaming; reward per UCU decouples from cost | Avoid |
| BME with stable credit (Helium DC / Akash ACT): burn ELO → mint non-transferable "UCU credits" redeemable for compute | Creates real token demand (sink); credits stay stable; proven 2023–26 | Needs a redemption counterparty (actual compute supply), a price oracle (Pyth/Chainlink TWAP) and circuit breakers | Phase 2, only if EloCoin can deliver compute (partner inference providers) |
| Work-token (stake ELO to act as attestor or compute provider) | Aligns attestors; slashing | Needs a decentralized attestor or provider market | Phase 2–3 (with AVS/CRE) |
| Stable-value UCU token (1 token = 1 UCU of compute, fully redeemable) | Most "meaningful" UCU | It is effectively a prepaid compute voucher or stablecoin, with a custody, reserve and regulatory burden | Only via a redemption partner; probably not a fit for a small team |

- **Keeping 1 UCU meaningful:** define UCU in **hardware-normalized units**, for example "1 UCU = X H100-equivalent GPU-seconds", or FLOPs at a reference efficiency, estimated per model from published or estimated parameters. Hardware price-performance deflates far more slowly than model price per capability, and there is now a **public price benchmark** (Silicon Data H100 Rental Index, CME futures since Oct 2026) that a USD-denominated redemption could reference.
- Alternatively, use a **USD-spend basis** (verified $ spent → UCU). This is simplest to verify via cost APIs, but it rewards spend, not compute.
- Either way, **version the UCU definition** (UCU-v1, v2 …) with an on-chain registry of conversion tables (model → UCU factor), changes behind a timelock, and the factor table hash in each attestation. This matches the repo's "versioned definitions and calibration qualifications" (docs/roadmap.md).
- **Emission recommendation for MVP:**
  - hard cap (for example 1B);
  - a fixed share (for example 30–50%) reserved for a usage-mining pool, released on a declining schedule (halving every 1–2 years);
  - each epoch's pool split pro rata by verified UCU, with per-account caps;
  - add a BME sink later only when there is something to redeem.
  - This is not a "1 UCU = 1 token" peg, which would be unbounded and gameable.

### Gaps
- Exact Render BME mechanics (fee percentage, how node rewards scale with burn) were not verified from Render's own docs (fetch failed).
- Akash provider-payment mechanics conflict across sources.
- No quantitative study was found on long-run BME equilibrium outcomes; Helium's price history suggests BME alone does not support token value.
- No existing "unit of AI compute" index standard (FLOP-based) beyond GPU-hour rental indices.
- Whether CME GPU1 actually began trading on Oct 5, 2026 was not confirmed.

---

## 5. Smart contract stack (OpenZeppelin, Safe mint authority, upgradeability, timelocks) and audits (firms, cost, lead time)

### Takeaway
Use OpenZeppelin Contracts v5.x:
- a **minimal, non-upgradeable, capped ERC-20** (ERC20Permit + ERC20Bridgeable);
- a separate **MintController** (Merkle-claim distributor with epoch caps) that holds the only minter role;
- admin via **AccessManager/AccessControl → TimelockController → Safe multisig**, plus a fast pause guardian.

Audit budget: a plain ERC-20 is about $5k–$15k, but the minting/oracle/claim logic puts EloCoin in the "standard DeFi" tier. Plan for about $20k–$60k for one reputable firm, plus a re-audit at $5k–$20k, and 3–6 weeks of audit time on top of booking lead time. This range is inferred from the cited ranges; get quotes.

### Cited Findings
- **OpenZeppelin v5:**
  - AccessManager arrived in 5.0 (2023), which "modernizes access control" — [OpenZeppelin 5.0 announcement](https://www.openzeppelin.com/news/introducing-openzeppelin-contracts-5.0);
  - upgradeable v5 contracts use ERC-7201 namespaced storage;
  - in v5.5+, `Initializable` and `UUPSUpgradeable` should be imported from `@openzeppelin/contracts`, and the aliases will be removed in the next major (third-party skill doc) — [OpenZeppelin upgrade skill](https://claudeskills.info/skills/openzeppelin/openzeppelin-skills/upgrade-solidity-contracts/);
  - a registry shows contracts-upgradeable paired with contracts 5.4.0 — [Tessl registry](https://tessl.io/registry/tessl/npm-openzeppelin--contracts-upgradeable);
  - `ERC20Bridgeable` gives ERC-7802 compatibility — [OpenZeppelin ERC20 API](https://docs.openzeppelin.com/contracts/api/token/erc20).
- **Audit pricing (2026, mostly firms' own marketing benchmarks):**
  - Simple ERC-20: from $5,000 — [Sherlock 2026 pricing reference](https://www.sherlock.xyz/post/smart-contract-audit-pricing-a-market-reference-for-2026); from $1,000 — [QuillAudits 2026](https://www.quillaudits.com/blog/smart-contract/smart-contract-audit-cost-2026); $5k–$15k — [Zealynx 2026](https://www.zealynx.io/blogs/audit-pricing-2026); $3k–$5k — [SoluLab](https://www.solulab.com/smart-contract-audit-cost/).
  - Timelines: 2–8 days for a simple token, 3–6 weeks for standard DeFi — [QuillAudits](https://www.quillaudits.com/blog/smart-contract/smart-contract-audit-cost-2026); standard DeFi 3–6 weeks, Trail of Bits 4–10 weeks turnaround — [Zealynx](https://www.zealynx.io/blogs/audit-pricing-2026).
  - Modifiers: rush premium of 20–50% per [QuillAudits](https://www.quillaudits.com/blog/smart-contract/smart-contract-audit-cost-2026), but 10–20% per [Zealynx](https://www.zealynx.io/blogs/audit-pricing-2026) (conflict); re-audit passes $5k–$20k each — [Sherlock](https://www.sherlock.xyz/post/smart-contract-audit-pricing-a-market-reference-for-2026); Rust/Move 20–30% more than Solidity — [Zealynx](https://www.zealynx.io/blogs/audit-pricing-2026).
- **Operational security precedent:** KelpDAO's emergency multisig blocked a second fraudulent 40,000 rsETH release, showing the value of a fast pause or guardian path. — [Blockaid](https://www.blockaid.io/blog/how-a-single-layerzero-dvn-compromise-drained-292m-from-kelpdao)

### Inferences (recommended stack)

**Contracts**
- `EloToken`: ERC20 + ERC20Permit + ERC20Capped + ERC20Bridgeable. It is **non-upgradeable**, because token immutability is a trust signal and shrinks the audit surface. It has a single `MINTER` role and no owner-mint.
- `UCURegistry`: versioned model→UCU factor tables, with the hash committed per epoch.
- `EpochMinter`:
  1. accepts a Merkle root per epoch, signed by an attestor key (EIP-712) or posted by an oracle;
  2. enforces a global epoch cap and the emission schedule;
  3. runs a challenge window, during which a guardian can veto the root;
  4. lets users claim with proofs, with optional vesting or clawback.
- Optionally EAS schemas for per-account attestations, giving a transparent audit trail.

**Upgradeability**
- Only `EpochMinter` and `UCURegistry` are upgradeable, via UUPS behind a timelock.
- Or make them non-upgradeable and swap the minter role to a new contract via the timelock (simpler to audit).

**Governance and keys**
- Safe multisig (3-of-5, hardware keys, geographically distributed) → `TimelockController` (48–72h delay) → admin roles.
- A separate 1-of-N or 2-of-N **pause guardian** that can pause minting and claims but cannot mint.
- The attestor signing key lives in an HSM, cloud KMS or TEE, and is rotatable by the timelock.
- These are standard practices; Safe and Timelock docs were not re-fetched this session.

**Audit plan**
- Keep the codebase small (about 500–1,000 nSLOC).
- Run an internal review plus Slither and Foundry invariant fuzzing.
- One firm audit, then optionally a competitive audit contest (Sherlock, Code4rena, Cantina).
- A bug bounty (Immunefi) at launch.
- Book auditors 4–8+ weeks ahead. Top-tier firms carry longer backlogs (Trail of Bits turnaround of 4–10 weeks).

**Budget (inferred)**
- Firm audit: about $20k–$60k mid-tier, more for top-tier.
- Re-audit: $5k–$20k.
- Bounty pool: hold separately.
- Deployment gas on Base: negligible (cents to a few dollars).

### Gaps
- Top-tier firm weekly rates (Trail of Bits, OpenZeppelin, Spearbit, ChainSecurity) and contest pricing could not be retrieved (Sherlock and Zealynx pages failed DNS in WebFetch; only search summaries were available).
- Immunefi bounty norms were not researched.
- The current OpenZeppelin release number (5.5/5.6?) is not confirmed from the official changelog.
- Safe and TimelockController best-practice docs were not fetched this session.

---

## 6. Minimal viable launch architecture and engineering timeline for a small team

### Takeaway
A credible MVP, inferred from the findings above:
- an ERC-20 on Base with a capped, epoch-based Merkle mint;
- a centralized but transparent **attestor service** that pulls **org-level Anthropic and OpenAI Admin usage APIs** (Tier A only), converts usage to versioned UCU, signs or publishes per-epoch roots (optionally as EAS attestations), and enforces caps, KYC/KYB and challenge windows;
- Safe + Timelock governance.

A 2–3-engineer team can reach a guarded mainnet in about 4–6 months, including a 3–6 week audit. TEE-attested local inference, CRE/AVS decentralization, cross-chain, and BME redemption belong in later phases.

### Cited Findings
- Org-level usage data with per-user/day and per-key granularity is available from Anthropic (Usage & Cost API; Claude Code Analytics API, ≤1h delay) and OpenAI (usage/completions, costs). — [Anthropic Usage & Cost API](https://platform.claude.com/docs/en/build-with-claude/usage-cost-api); [Claude Code Analytics API](https://platform.claude.com/docs/en/build-with-claude/claude-code-analytics-api); [OpenAI Cookbook](https://developers.openai.com/cookbook/examples/completions_usage_api)
- Chainlink Functions sunsets Sep 1, 2026, and CRE is the replacement, so new oracle integrations should target CRE. — [Chainlink Functions](https://functions.chain.link/mainnet)
- EAS on Base costs about $0.002 per attestation (non-authoritative). — [socket.dev](https://socket.dev/npm/package/@cellar-door/eas)
- Audits take 3–6 weeks for DeFi-tier scope; plan for re-audits. — [QuillAudits](https://www.quillaudits.com/blog/smart-contract/smart-contract-audit-cost-2026); [Sherlock](https://www.sherlock.xyz/post/smart-contract-audit-pricing-a-market-reference-for-2026)
- GPU TEE inference is deployable today (Phala, Chutes, io.net CC VMs) for a later "verified local or self-hosted inference" tier. — [Phala deployment guide](https://docs.phala.com/phala-cloud/confidential-ai/gpu-tee-deployment-guide); [io.net CC guide](https://io.net/docs/guides/clouds/confidential-compute-attestation-guide)
- Tokenelo's tracker is local-first and requires "no ... crypto wallet, or reward mechanism"; EloCoin is "a separate product pursuit". — /home/user/Tokenelo/README.md; /home/user/Tokenelo/docs/licensing.md (repo files)

### Inferences

**MVP architecture (Phase 1)**

1. **Tokenelo client (unchanged core)**: an optional "EloCoin link" module that displays local UCU estimates. It never submits local logs as mint evidence (Tier C).
2. **EloCoin Attestor service** (TypeScript/Go):
   - org onboarding (KYB);
   - encrypted storage of read-only admin keys, or zkTLS proofs in Phase 2;
   - a daily job that pulls the Anthropic usage_report/messages and claude_code reports and the OpenAI usage and costs endpoints;
   - dedupe by provider org ID and key ID;
   - convert to UCU-vN using the on-chain registry hash;
   - anomaly checks, then build the Merkle tree;
   - publish the tree off-chain (IPFS/S3) and the root on-chain;
   - optional EAS offchain attestations per account.
   - Signing key held in KMS/HSM.
3. **Contracts on Base**: `EloToken` (immutable, capped, ERC-7802-ready), `EpochMinter` (cap, challenge window, guardian veto, claims), `UCURegistry` (versioned factors). Governed by Safe → Timelock.
4. **Transparency**: a public dashboard with per-epoch totals, the methodology and version, and the attestor's signed reports. The repo's data-accuracy principles (coverage gaps visible, calibration status) carry over directly.

**Timeline (2–3 engineers + part-time security/legal)**

| Weeks | Work |
|---|---|
| 0–4 | Spec: UCU-v1 definition and factor table, threat model, emission parameters, legal review gate (other workstream) |
| 4–12 | Build contracts (Foundry tests, invariant fuzzing) and attestor pipeline; testnet (Base Sepolia) with internal orgs |
| 10–12 | Freeze code; book audit (ideally booked at week 4–6) |
| 12–18 | External audit (3–6 weeks) + fixes + re-audit; bug bounty setup; dry-run epochs on testnet with real usage data |
| 18–24 | Guarded mainnet: low per-epoch caps, allowlisted KYB'd orgs, 7-day challenge window, vesting; then gradual cap increases |

**Rough external costs (inferred; verify)**
- audit $20k–$60k plus re-audit $5k–$20k;
- bug bounty pool (variable);
- KYB/KYC vendor fees;
- infrastructure (KMS, RPC, indexer) about $hundreds/month;
- Base gas is negligible.
- Initial DEX liquidity is a separate tokenomics/treasury decision.

**Phase 2 (months 6–12)**
- zkTLS-based user-held proofs, so EloCoin no longer custodies admin keys;
- move the attestor to a Chainlink CRE workflow or multi-signer committee;
- a TEE-attested self-hosted inference tier (TDX + H100/H200 CC via NRAS or Intel Trust Authority), with a discount factor for TEE.fail risk;
- Human Passport gating for retail.

**Phase 3 (12+ months)**
- BME sink (burn ELO → non-transferable UCU credits redeemable with partner inference providers, using a Pyth or Chainlink TWAP oracle with Akash-style circuit breakers);
- an EigenLayer AVS or staked attestor set with slashing;
- cross-chain via CCIP CCT or multi-DVN OFT.

**Immature or avoid (as of Oct 2026)**
- zkML for LLM-scale usage proofs;
- single-verifier bridges;
- Chainlink Functions (sunset);
- treating TEE attestation as secure against hardware owners;
- per-UCU uncapped minting;
- minting from subscription-plan or local-log usage.

### Gaps
- No primary source on engineering-time benchmarks for comparable token launches. The timeline above is an inference.
- KYB/KYC vendor pricing not researched.
- Provider ToS compatibility (using Admin API data to drive token rewards) is unverified and could block the Tier A design.
- Regulatory classification of usage-mined tokens is out of scope here (other workstream) but is a gating dependency for the timeline.

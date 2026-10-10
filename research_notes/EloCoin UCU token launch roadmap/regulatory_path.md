# Regulatory Path for Issuing and Listing EloCoin (US primary, EU/MiCA secondary), as of October 10, 2026

This is research, not legal advice. Method note: in this session, direct page fetches were blocked (egress/DNS), so all "Cited Findings" come from web-search result summaries of the linked pages. Items marked **[prior knowledge, not re-verified this session]** come from well-known primary documents whose URLs are given but whose text I could not reload. Anything marked **PENDING** or **PROPOSED** has no legal effect yet. Every item needs confirmation by US securities, commodities, payments and tax counsel, and by EU counsel for MiCA, before anyone relies on it.

---

## 1. US securities law status (Howey, SEC guidance 2025–2026, token taxonomy) and what it means for a "use/measure-AI-compute-to-earn" token

### Takeaway
The governing US framework is now the SEC's **March 17, 2026 Commission-level interpretation**, issued with the CFTC. It sorts tokens into five categories and treats digital commodities, digital tools and digital collectibles as non-securities, though they can still be sold *within* an investment contract. It also says protocol mining, protocol staking, wrapping and *no-consideration* airdrops are not securities transactions. The catch for EloCoin is twofold. A token whose rewards a **central party** measures and distributes does not fit cleanly into the "digital commodity" definition, and **task-based / "earn by doing" distributions are excluded** from the airdrop safe conclusion. The closest favorable precedents are the DePIN no-action letters (DoubleZero, Fuse), which apply only to their own facts.

### Cited Findings
**March 17, 2026 SEC interpretation (Release Nos. 33-11412 / 34-105020):**
- The SEC and CFTC issued a joint interpretation on March 17, 2026. It sets out a token taxonomy and explains how a non-security token can become subject to an investment contract. — [Sullivan & Cromwell](https://www.sullcrom.com/insights/memo/2026/March/SEC-Clarifies-Application-Securities-Laws-Crypto-Assets); [Davis Polk](https://www.davispolk.com/insights/client-update/sec-begins-clarify-application-federal-securities-laws-crypto); [Sidley](https://datamatters.sidley.com/2026/03/24/sec-releases-landmark-interpretation-on-application-of-u-s-securities-laws-to-crypto-assets-in-coordination-with-cftc/)
- Sources differ on who issued it. Some say the SEC issued it and the CFTC said separately that it would administer the CEA consistently with it. Others call it a joint release. It is an **interpretation, not a binding regulation**. — [Paul Weiss](https://www.paulweiss.com/insights/client-memos/sec-and-cftc-release-interpretation-on-application-of-federal-securities-laws-to-crypto-assets); [Jenner](https://www.jenner.com/en/news-insights/client-alerts/sec-and-cftc-issue-landmark-joint-interpretation-on-crypto-asset-classification)
- **Five categories:** digital commodities, digital collectibles, digital tools, stablecoins and digital securities. The first three are not securities in themselves but "may be subject to an investment contract." It supersedes the 2019 staff "framework" for investment-contract analysis of digital assets. — [Dechert](https://www.dechert.com/knowledge/onpoint/2026/3/sec-s-crypto-framework--the-new-token-taxonomy.html); [Ropes & Gray](https://www.ropesgray.com/en/insights/alerts/2026/03/sec-and-cftc-issue-landmark-joint-guidance-on-classification-of-crypto-assets)
- **Digital commodity definition:** value comes from the "programmatic operation of a functional crypto system" and supply and demand, not from others' essential managerial efforts. It is tied to a functional system **without a "central party" that oversees participation or distributes rewards**, and it has no intrinsic economic rights such as passive yield. — [Paul Weiss](https://www.paulweiss.com/insights/client-memos/sec-and-cftc-release-interpretation-on-application-of-federal-securities-laws-to-crypto-assets); [Mondaq](https://www.mondaq.com/unitedstates/fintech/1766036/sec-and-cftc-issue-interpretive-guidance-establishing-crypto-asset-classification-framework)
- **Digital tools:** assets that perform a practical function, such as a membership, ticket, credential or identity badge. They **may be issued by a central party** or autonomously. — [Paul Weiss](https://www.paulweiss.com/insights/client-memos/sec-and-cftc-release-interpretation-on-application-of-federal-securities-laws-to-crypto-assets)
- **Named digital commodities:** one source counts 16 explicitly named (including BTC, ETH, SOL); Jenner refers to 18. The count is in conflict, and the list is illustrative. — [FinTech Weekly](https://www.fintechweekly.com/news/sec-bitcoin-ether-solana-digital-commodities-not-securities-march-2026); [Jenner](https://www.jenner.com/en/news-insights/client-alerts/sec-and-cftc-issue-landmark-joint-interpretation-on-crypto-asset-classification)
- **Howey gloss:** the agencies add an element that the issuer must *affirmatively make representations or promises* about its essential managerial efforts. — [Lowenstein](https://www.lowenstein.com/news-insights/publications/client-alerts/sec-issues-interpretive-framework-for-crypto-asset-classification-fctm)
- **Investment contracts can end:** once purchasers can no longer reasonably expect the issuer's essential managerial efforts to stay connected to the asset, the asset "separates" from those promises and is no longer subject to the securities laws. Commentators say *when* separation occurs is the main open question, and that abandonment does not cure an original unregistered offer. — [Sidley](https://datamatters.sidley.com/2026/03/24/sec-releases-landmark-interpretation-on-application-of-u-s-securities-laws-to-crypto-assets-in-coordination-with-cftc/); [VG Law](https://www.vglawfirm.com/sec-crypto-interpretation-token-taxonomy-2026)
- **Activities outside securities laws:** certain proof-of-work mining, proof-of-stake staking, redeemable wrapped-token arrangements and airdrops of non-security assets are not securities transactions. Staking rewards are treated as **consideration for validation services**. Restaking and arrangements with broader discretion or guaranteed rewards fall outside the interpretation. — [DLA Piper](https://www.dlapiper.com/en-us/insights/publications/2026/03/sec-and-cftc-issue-interpretive-release-on-crypto); [Davis Polk](https://www.davispolk.com/insights/client-update/sec-begins-clarify-application-federal-securities-laws-crypto)
- **Airdrop limit (critical for use-to-earn):** "covered airdrops" lack Howey's "investment of money" element *only* when they are **no-consideration** airdrops of non-security assets. The conclusion **excludes arrangements where recipients must perform tasks, make purchases, or otherwise provide value**. Commentators read social, referral and task-based airdrops and points programs as outside the safe conclusion. — [DLA Piper](https://www.dlapiper.com/en-us/insights/publications/2026/03/sec-and-cftc-issue-interpretive-release-on-crypto); [Venable](https://www.venable.com/insights/publications/2026/04/new-paradigm-for-crypto-assets-a-deep-dive-into); [Ballard Spahr](https://www.ballardspahr.com/insights/alerts-and-articles/2026/03/sec-and-cftc-clarify-when-digital-assets-are-and-are-not-securities)
- One summary dates the release March 23, 2026; most say March 17. — [Venable](https://www.venable.com/insights/publications/2026/04/new-paradigm-for-crypto-assets-a-deep-dive-into)

**Project Crypto background (2025, older; largely superseded by the March 2026 interpretation):**
- In March 2026 remarks, SEC Chairman Atkins presented a "token safe harbor" as part of a forthcoming "Regulation Crypto Assets." — [SEC speech, Atkins, Mar 17 2026](https://www.sec.gov/newsroom/speeches-statements/atkins-remarks-regulation-crypto-assets-031726)
- 2025 staff statements: meme coins (Feb 27, 2025), "protocol mining" (Mar 20, 2025: PoW mining rewards are not securities transactions), covered stablecoins (Apr 4, 2025) and protocol staking (May 29, 2025). — [prior knowledge, not re-verified this session] [SEC protocol-mining statement](https://www.sec.gov/newsroom/speeches-statements/statement-certain-protocol-mining-activities-032025); [SEC protocol-staking statement](https://www.sec.gov/newsroom/speeches-statements/statement-certain-protocol-staking-activities-052925)

**DePIN no-action letters (staff-level, fact-specific):**
- **DoubleZero (2Z), Sept 29, 2025:** Corporation Finance said it would not recommend enforcement. The 2Z flows are "programmatic transfers" embedded in network logic, described as rewards to contributors who provide network resources. Commissioner Peirce stressed that DePIN differs from capital-raising. The relief is conditional on the facts represented. — [Sumsub](https://sumsub.com/media/news/sec-declares-depin-tokens-outside-jurisdiction/); [IoTeX analysis](https://iotex.io/blog/secs-depin-no-action-letter-4-takeaways-and-what-it-means-for-iotex/); [Unlock-bc](https://www.unlock-bc.com/en/sec-says-depin-tokens-fall-outside-its-oversight-in-rare-no-action-letter)
- **Fuse (FUSE), Nov 2025:** a Solana DePIN network token issued as a reward to those actively maintaining the network. Fuse's request (Nov 19) represented that FUSE is for network utility and consumption, not speculation. Staff gave no-action relief "in reliance on your opinion as counsel" for offers and sales as described. — [Cointelegraph](https://cointelegraph.com/news/sec-no-action-letter-fuse-depin-project)

**Proposed Regulation Crypto Assets (see section 2 for details):** it would expressly bring **airdrops and network rewards** inside its "covered transaction" concept for the startup exemption. — [Troutman](https://www.troutman.com/insights/key-takeaways-from-the-secs-proposed-regulation-crypto-assets/); [MoFo](https://www.mofo.com/resources/insights/260819-sec-proposes-new-regulation-crypto-assets)

### Inferences
- **EloCoin's main securities risk is structural.** If Tokenelo/EloAI centrally measures compute and decides reward amounts, the token probably fails the "digital commodity" test at launch, because a central party distributes rewards. The realistic non-security categories are (a) a **digital tool** (if EloCoin is primarily a credential or access token for compute or services) or (b) a DePIN-style **payment for services** (if rewards compensate users for supplying or verifying compute or measurement data, as staking and mining rewards compensate validation).
- "Use AI to earn tokens" looks like a task-based airdrop or points program, which the interpretation expressly excludes. "Supply or verify measurable compute work to the network, paid programmatically under published rules" looks like mining or DePIN, which the SEC has treated favorably. Product and tokenomics design should aim for the second. Concretely: deterministic, published, on-chain or verifiable reward formulas; no discretionary team-run reward adjustments; no yield; and no marketing that promises price appreciation from team efforts.
- Because the March 2026 interpretation adds an "affirmative promises of managerial efforts" element, **marketing discipline is itself a compliance control**. Avoid roadmaps that promise to increase token value, buybacks or listings.
- The fastest way to reduce US securities uncertainty without legislation is likely an **SEC no-action request modeled on DoubleZero/Fuse**. Turnaround is unknown (see Gaps). Without one, the project relies on a counsel opinion against the March 2026 interpretation.

### Gaps
- I could not fetch the release text, so I could not confirm the exact definitional language for "digital tool," whether the interpretation addresses DePIN or "proof-of-useful-work" rewards directly, or how it treats rewards paid by a centralized off-chain oracle (such as compute measurement).
- No-action letter processing times and costs for DoubleZero and Fuse were not found.
- No source found addresses an "AI compute measurement" reward token specifically.

---

## 2. Market-structure legislation (CLARITY Act / Senate bills) and any token safe harbor: what has passed and what it would require

### Takeaway
**No market-structure statute has passed.** The House passed CLARITY (H.R. 3633) in 2025. Senate Banking advanced its version on May 14, 2026. On **September 15, 2026, the Senate cloture vote on the motion to proceed failed 49–50**, and the bill is stalled until at least the post-midterm lame duck, and possibly the next Congress. The only "safe harbor" in play is the SEC's **proposed** Regulation Crypto Assets (published Aug 21, 2026; **comments due Oct 20, 2026**; final rules not expected before Q1 2027 per White & Case). EloCoin cannot rely on any statutory or rule-based safe harbor as of October 2026.

### Cited Findings
**Legislation:**
- The Senate failed to invoke cloture on the motion to proceed to H.R. 3633 on Sept 15, 2026, 49–50, 11 short of 60. This was not a vote on final passage. — [CNBC](https://www.cnbc.com/2026/09/15/senate-cloture-vote-on-clarity-act-fails-dealing-regulatory-setback-to-crypto-industry.html); [American Banker](https://www.americanbanker.com/news/crypto-market-structure-bill-fails-in-senate-vote-49-50); [Hunton](https://www.hunton.com/blockchain-legal-resource/senate-fails-to-advance-clarity-act)
- The main dispute was over ethics provisions targeting crypto profits of President Trump and his family. No Democrats voted yes. Sources differ on the Republican defections: Yahoo lists Collins, Hawley, Moran and Tillis, while Forbes says three Republicans. Tillis changed his vote so he could move to reconsider after the midterms. — [Forbes](https://www.forbes.com/sites/digital-assets/2026/09/16/failure-of-crypto-clarity-act-cloture-vote-not-a-surprise/); [Yahoo Finance](https://finance.yahoo.com/markets/crypto/articles/clarity-act-senate-vote-live-183611039.html); [American Banker](https://www.americanbanker.com/news/crypto-market-structure-bill-fails-in-senate-vote-49-50)
- American Banker says the vote has likely stalled the bill until the next Congress. A motion to reconsider is pending, with no new vote scheduled. Midterms are Nov 3, 2026, and bills not enacted in the 119th Congress must be reintroduced in January 2027. — [American Banker](https://www.americanbanker.com/news/crypto-market-structure-bill-fails-in-senate-vote-49-50); [bit.com](https://www.bit.com/knowledge-hub/clarity-act-senate-vote)
- One fact sheet puts the odds of passage at 7%–9%. This is an odds or estimate figure, not an official one. — [DeFi Rate](https://defirate.com/clarity-act-fact-sheet/)
- Senate Banking advanced its bill 15–9 on May 14, 2026; it was formally reported June 1. — [Davis Wright Tremaine](https://www.dwt.com/blogs/financial-services-law-advisor/2026/05/senate-banking-crypto-market-structure-bill); [DeFi Rate](https://defirate.com/clarity-act-fact-sheet/)
- **What the bills would require (not law):**
  - **House CLARITY:** "mature blockchain" certification based on functionality, open-source code, transparent rules, and no single party holding 20% or more of supply or voting power, with a 60-day SEC challenge window. It includes a Section 4(a)(8) offering exemption for digital commodities. — [Arnold & Porter](https://www.arnoldporter.com/en/perspectives/advisories/2025/08/clarifying-the-clarity-act); [Paul Hastings](https://www.paulhastings.com/insights/crypto-policy-tracker/update-on-crypto-market-structure-legislation-senate-banking-draft-and-clarity-act)
  - **Senate Banking:** an "ancillary asset" category (value depends on an originator's efforts) with SEC disclosure obligations, a "Regulation DA" offering exemption, a test based on "coordinated control" and whether the originator's efforts still drive value, and a 90-day SEC objection period on maturity certification. One source cites a 49% beneficial-ownership threshold, which conflicts with the 20% figure tied to the House text. — [Sumsub](https://sumsub.com/blog/clarity-act-guide/); [Pantera](https://panteracapital.com/clarity-act-senate-banking/); [Paul Hastings](https://www.paulhastings.com/insights/crypto-policy-tracker/update-on-crypto-market-structure-legislation-senate-banking-draft-and-clarity-act)
- The House passed CLARITY 294–134 on July 17, 2025. — [prior knowledge, not re-verified this session] [congress.gov H.R. 3633](https://www.congress.gov/bill/119th-congress/house-bill/3633)

**SEC Proposed "Regulation Crypto Assets" (File No. S7-2026-27):**
- Proposed in August 2026 (Peirce statement dated Aug 18, 2026), published in the Federal Register Aug 21, 2026, with **comments due Oct 20, 2026**. White & Case does not expect final rules before Q1 2027 and says they "may look meaningfully different." — [Federal Register](https://www.federalregister.gov/documents/2026/08/21/2026-17183/regulation-crypto-assets); [SEC press release 2026-76](https://www.sec.gov/newsroom/press-releases/2026-76-sec-proposes-new-regulation-crypto-assets); [White & Case](https://www.whitecase.com/insight-alert/sec-proposes-regulation-crypto-assets-rulemaking); [Peirce statement](https://www.sec.gov/newsroom/speeches-statements/peirce-statement-regulation-crypto-assets-081826)
- **Startup exemption:** a one-time, non-exclusive exemption for up to **$5M over four years**. No financial statements. No accredited-investor condition, no individual investment limit, general solicitation allowed, and the instruments are **not restricted securities** (no Rule 144-style holding period). — [Journal of Accountancy](https://www.journalofaccountancy.com/news/2026/aug/sec-proposal-aims-to-clarify-securities-rules-for-crypto-assets/); [Lexology](https://www.lexology.com/library/detail.aspx?g=3b069674-71fc-4af0-9f17-e967ae3ca53f)
- **Fundraising exemption:** up to **$75M per 12 months** in two tiers (Tier 1 $20M, Tier 2 $75M). It requires financial statements and ongoing reporting and is limited to US-anchored issuers. — [White & Case](https://www.whitecase.com/insight-alert/sec-proposes-regulation-crypto-assets-rulemaking); [Lexology](https://www.lexology.com/library/detail.aspx?g=45ec4ef4-55ad-4b90-a061-b0c0f97ce65e)
- Both exemptions require principles-based narrative disclosure. Antifraud and antimanipulation rules still apply. — [Journal of Accountancy](https://www.journalofaccountancy.com/news/2026/aug/sec-proposal-aims-to-clarify-securities-rules-for-crypto-assets/)
- **"Covered transaction"** expressly includes airdrops and network rewards. Projects that give tokens away should not assume they are outside the regime. — [Troutman](https://www.troutman.com/insights/key-takeaways-from-the-secs-proposed-regulation-crypto-assets/); [MoFo](https://www.mofo.com/resources/insights/260819-sec-proposes-new-regulation-crypto-assets)
- **Safe harbor:** a conditional, non-exclusive safe harbor from the term "investment contract." In substance it is an off-ramp once the issuer stops performing the essential managerial efforts or fulfills its development commitments. One commentary calls it a proposed "Rule 400." It does not stop *other parties* (for example, private plaintiffs) from arguing the token is still a security. I found no specific numeric "decentralization test" in the proposal. — [Lexology](https://www.lexology.com/library/detail.aspx?g=3b069674-71fc-4af0-9f17-e967ae3ca53f); [Stinson](https://www.stinson.com/newsroom-publications-sec-proposes-regulation-crypto-assets-creating-a-tailored-offering-framework-for-crypto-investment-contracts); [Fintech & Digital Assets blog](https://www.fintechanddigitalassets.com/2026/09/sec-proposes-tailored-exemptions-for-cryptoasset-offerings/)

### Inferences
- **Planning assumption for an October 2026 launch:** no statute and no final SEC exemption. Design the launch to fit the **existing March 2026 interpretation** (non-sale programmatic distribution) plus traditional exemptions (Reg D/Reg S) for any capital raise.
- EloAI may want to **comment on Reg Crypto Assets by Oct 20, 2026**, specifically on how "network rewards" for useful-work or compute measurement are treated. If the final rule lands in 2027, the $5M startup exemption (no restricted-securities lockup, general solicitation allowed) could suit a small US community distribution or sale.
- If CLARITY is revived in 2027, its maturity tests (20% or 49% control threshold; certification with a 60- or 90-day SEC review) argue for capping insider and treasury holdings and avoiding unilateral admin keys from day one. That keeps the option open.

### Gaps
- Senate Agriculture Committee bill (CFTC title) status in 2026: not found in this session.
- Final text of the Senate Banking "ancillary asset" disclosure list and the exact control threshold: conflicting secondary sources (20% vs 49%).
- Whether a lame-duck vote is actually scheduled: no source as of Oct 10, 2026.

---

## 3. CFTC jurisdiction: "digital commodities," compute-indexed tokens, compute futures; spot vs. derivatives

### Takeaway
If EloCoin is a non-security token, its **spot market** sits under CFTC anti-fraud and anti-manipulation authority but **no federal spot-exchange registration regime** (that needed CLARITY). **Derivatives** on it (futures, perps, leveraged retail trades) are fully CFTC-regulated. **Compute futures** are arriving through CME's H100/B200 rental-rate contracts (planned Oct 5, 2026; status unconfirmed). A token that delivers synthetic or leveraged exposure to compute prices, rather than redeemable compute, risks being treated as a swap or futures contract.

### Cited Findings
- Listed spot crypto began trading on federally regulated US markets in **December 2025**, after an SEC–CFTC staff statement that current law does not bar registered exchanges from facilitating certain spot crypto trades. — [Coinpaprika](https://coinpaprika.com/news/cftc-proposes-first-crypto-market-rules/); [crypto.news](https://crypto.news/us/cftc/)
- On **May 29, 2026**, the CFTC approved a DCM listing of a true perpetual contract on bitcoin (BTCPERP). — [Dechert](https://www.dechert.com/knowledge/onpoint/2026/6/cftc-takes-historic-steps-to-bring-digital-asset-perpetual-contr.html)
- On **Oct 5, 2026**, the CFTC issued an ANPRM on "Regulation Crypto Asset Transactions" (CTX) and "Regulation Crypto Asset Markets" (CAM). Leveraged, margined or financed retail crypto trading would route through FCMs subject to segregation and capital rules. — [Coinpaprika](https://coinpaprika.com/news/cftc-proposes-first-crypto-market-rules/); [Gate (secondary)](https://www.gate.com/news/detail/cftc-chair-selig-proposes-leveraged-retail-crypto-trading-via-fcm-lists-btc-24771439)
- Chairman Selig cited BTC, ETH, SOL, XLM, XTZ and XRP as digital commodities on Oct 5, 2026, consistent with the March 2026 interpretation. Selig is the **only sitting commissioner** (four seats vacant). — [Yahoo/CCN](https://finance.yahoo.com/markets/crypto/articles/cftc-chair-name-drops-6-120241624.html); [Coinpaprika](https://coinpaprika.com/news/cftc-proposes-first-crypto-market-rules/)
- **Compute futures:** CME planned to list two NYMEX contracts on Oct 5, 2026, tracking hourly **H100 and B200 rental rates** via Silicon Data indexes (DRW-backed). Each contract equals one month's rental of one GPU. Launch was "pending regulatory review," and go-live was not confirmed. — [Crypto Briefing](https://cryptobriefing.com/cme-group-compute-futures-launch/); [Silicon Data](https://silicondata.com/blog)
- H100 one-year rental pricing rose from about $1.70/hr (Oct 2025) to $2.35/hr (Mar 2026), per SemiAnalysis. — [SemiAnalysis](https://newsletter.semianalysis.com/p/the-great-gpu-shortage-rental-capacity)
- The CFTC already treats compute and GPU-rental rate indexes as legitimate commodity underlyings via DCM listing (CME). — [Crypto Briefing](https://cryptobriefing.com/cme-group-compute-futures-launch/)

### Inferences
- **Spot EloCoin trading (non-security):** CFTC anti-fraud and manipulation jurisdiction applies, including to issuer and market-maker conduct, wash trading and pumping. CEA §6(c)(1) and CFTC Rule 180.1 are the general basis [prior knowledge, not re-verified this session]. No CFTC license is needed just to issue or airdrop a commodity.
- **"Compute-indexed" design matters.** If EloCoin is redeemable for actual compute at a published rate, that is a commercial or consumptive use (closer to a "digital tool"). If EloCoin's value is engineered to track a compute price index without delivery, or if Tokenelo offers leveraged or margined trading or forward delivery, CFTC derivatives rules (swaps, futures, retail commodity transactions) are likely triggered. Counsel needed.
- With CME compute futures (if live) and a CFTC chair friendly to crypto, a later "EloCoin/compute" derivative would have to be listed on a DCM by a registered venue. That is not an issuer-run product.

### Gaps
- Whether the CME compute futures actually began trading on Oct 5, 2026, and their CFTC self-certification details: not confirmed.
- Senate Agriculture market-structure text (CFTC spot registration for "digital commodity exchanges"): status not found.
- No source on how the CFTC would classify a token whose issuance is pegged to measured compute units.

---

## 4. Is earning tokens for usage (use-to-earn / airdrops) a securities offering? Team/investor allocations, pre-sales, SAFTs; Reg D / Reg S / Reg A+ options

### Takeaway
A **pure no-consideration airdrop** of a non-security token is not a securities transaction under the March 2026 interpretation. **Task-based "earn by using" distributions are not covered** and get a facts-and-circumstances Howey analysis. Rewards structured as **compensation for verifiable network services** (mining, staking or DePIN contribution) have the strongest support. **Any sale** to investors (pre-sale, SAFT, team or investor tokens sold for value) remains a securities offering requiring an exemption: Reg D 506(b)/(c) for US accredited buyers, Reg S offshore, or Reg A+ or the proposed Reg Crypto Assets exemptions later.

### Cited Findings
- Covered airdrops are limited to no-consideration distributions and exclude task, purchase or "provide value" arrangements. — [DLA Piper](https://www.dlapiper.com/en-us/insights/publications/2026/03/sec-and-cftc-issue-interpretive-release-on-crypto); [Venable](https://www.venable.com/insights/publications/2026/04/new-paradigm-for-crypto-assets-a-deep-dive-into)
- Commentary says requiring tasks, referrals or staking supplies consideration, which satisfies Howey's investment element. Points programs are "not clearly covered." — [Venable](https://www.venable.com/insights/publications/2026/04/new-paradigm-for-crypto-assets-a-deep-dive-into); [Ballard Spahr](https://www.ballardspahr.com/insights/alerts-and-articles/2026/03/sec-and-cftc-clarify-when-digital-assets-are-and-are-not-securities)
- A non-security token distributed by airdrop may later become subject to an investment contract in a later transaction. Howey remains binding and the analysis is facts-and-circumstances. — [Venable](https://www.venable.com/insights/publications/2026/04/new-paradigm-for-crypto-assets-a-deep-dive-into)
- Staking rewards are characterized as consideration for validation services, not investment returns. — [DLA Piper](https://www.dlapiper.com/en-us/insights/publications/2026/03/sec-and-cftc-issue-interpretive-release-on-crypto)
- DePIN rewards for maintaining or contributing to a network got staff no-action relief (DoubleZero, Fuse). — [Cointelegraph](https://cointelegraph.com/news/sec-no-action-letter-fuse-depin-project); [Sumsub](https://sumsub.com/media/news/sec-declares-depin-tokens-outside-jurisdiction/)
- A non-security token **sold** with issuer promises of essential managerial efforts can be part of an investment contract. Securities-law status ends when those promises are fulfilled or no longer reasonably relied on, but the original offering still needed registration or an exemption. — [Sidley](https://datamatters.sidley.com/2026/03/24/sec-releases-landmark-interpretation-on-application-of-u-s-securities-laws-to-crypto-assets-in-coordination-with-cftc/); [VG Law](https://www.vglawfirm.com/sec-crypto-interpretation-token-taxonomy-2026)
- Proposed Reg Crypto Assets startup exemption: $5M over four years, no accredited-investor limit, not restricted securities. Fundraising exemption: $20M/$75M per 12 months with financials and ongoing reporting. **Not yet adopted.** — [Lexology](https://www.lexology.com/library/detail.aspx?g=3b069674-71fc-4af0-9f17-e967ae3ca53f); [White & Case](https://www.whitecase.com/insight-alert/sec-proposes-regulation-crypto-assets-rulemaking)
- Existing exemptions: Reg D 506(b) (no general solicitation; accredited investors plus up to 35 sophisticated non-accredited) and 506(c) (general solicitation; verified accredited only), with no dollar cap and resale restrictions. Reg A+ Tier 2 allows up to $75M per 12 months with SEC qualification. Reg S covers offshore offers and sales to non-US persons with distribution-compliance periods. — [prior knowledge, not re-verified this session] [SEC exempt offerings overview](https://www.sec.gov/resources-small-businesses/exempt-offerings)

### Inferences
- **Reward design for EloCoin:**
  - (1) Pay rewards for an **objectively measured service to the network**: contributing compute, running verifier or measurement nodes, or supplying signed benchmark or measurement data. Do not pay for "engagement" tasks (referrals, social posts, buying credits).
  - (2) Use deterministic, published emission schedules, ideally enforced on-chain.
  - (3) Do not require users to buy anything to earn. If paid compute usage earns tokens, that looks like "purchase plus rebate," which supplies consideration. This is a **high-risk point** if EloCoin is earned by *buying* AI compute from Tokenelo. Counsel should analyze whether usage-based rebates are a "purchase" that brings in Howey.
- **Team and investor allocations:** sell only through Reg D (US) and Reg S (non-US) using SAFTs or token warrants attached to equity. Impose lockups and vesting. The March 2026 "affirmative promises" element means SAFT and investor materials, which inevitably describe managerial efforts, make investor tranches investment contracts until separation. Disclose this and treat those tokens as restricted.
- **No public token sale** (ICO or IDO) to US persons before the Reg Crypto Assets final rule. It is the highest-risk path and slows exchange listing.

### Gaps
- No source in this session analyzed "usage rebates" (tokens earned in proportion to paid consumption) under the 2026 interpretation.
- Current market practice for SAFT and token-warrant terms in 2026 (lockups, unlock cliffs) was not researched here.

---

## 5. FinCEN/BSA money transmission, state MTLs (NY BitLicense, CA DFAL), KYC/AML/OFAC for an issuer distributing tokens and possibly running a redemption

### Takeaway
Under FinCEN's 2019 CVC guidance, an issuer becomes an "administrator," and so a **money transmitter** requiring MSB registration and a BSA program, when it **both issues and has authority to redeem** a centralized virtual currency, or sells to a group of buyers while being the only party that can issue and redeem. Miners and users who create tokens to pay for goods and services are generally not MSBs. A **fiat redemption window** run by Tokenelo is therefore the main MSB trigger. **State law** adds the NY BitLicense (which reportedly covers issuing and distributing virtual currency) and California's DFAL (license or pending application required since **July 1, 2026**). OFAC sanctions screening applies to any US person regardless.

### Cited Findings
- FinCEN defines an "administrator" as a person in the business of issuing (putting into circulation) a CVC who also has authority to redeem (withdraw from circulation) it. Administrators are money transmitters. — [FinCEN CVC Guidance, May 2019](https://www.fincen.gov/system/files/2019-05/FinCEN%20CVC%20Guidance%20FINAL.pdf)
- In an ICO to a select group, "at the time of the initial offering the seller is the only person authorized to issue and redeem… the new units," so the seller is a money transmitter. Commentators summarize that administrators of decentralized CVCs, ICO issuers and investors without issue-and-redeem control, and CVC miners generally are not. — [FinCEN CVC Guidance](https://www.fincen.gov/system/files/2019-05/FinCEN%20CVC%20Guidance%20FINAL.pdf); [Covington](https://www.cov.com/-/media/files/corporate/publications/2019/11/fincen-issues-guidance-to-synthesize-regulatory-framework-for-virtual-currency.pdf); [Jones Day](https://www.jonesday.com/en/insights/2019/06/fincen-consolidates-guidance)
- **California DFAL:** licensing went live **July 1, 2026**. Firms needed a license or an application filed by July 1, 2026. DFPI implementing regulations were disapproved by OAL on May 12, 2026, with revised text submitted June 5, 2026 and still pending. Sources conflict on token issuers: one says SB 97 removed standalone "digital financial asset administration," while another lists **redeemable-asset issuance** as covered. — [Goodwin](https://www.goodwinlaw.com/en/insights/publications/2026/04/alerts-finance-dcb-california-dfal-license-application-open); [MoFo](https://www.mofo.com/resources/insights/260729-california-digital-assets-and-fintech-update); [Hinshaw](https://www.hinshawlaw.com/en/insights/blogs/consumer-crossroads-where-financial-services-and-litigation-intersect/how-should-entities-prepare-for-californias-digital-financial-assets-law-licensing-requirement)
- **NY BitLicense:** commercial guides say covered virtual-currency business activity includes **controlling, administering or issuing** virtual currency, with a $5,000 application fee (23 NYCRR §200.5). These are secondary sources, and the rule text should be checked. — [InnReg](https://www.innreg.com/blog/bitlicense-new-york); [Faisal Khan](https://faisalkhan.com/solutions/licensing/cryptocurrency-licensing/bitlicense-new-york/)
- **OFAC:** sanctions compliance obligations apply to the virtual currency industry, including screening counterparties and wallet addresses. Liability is strict. — [prior knowledge, not re-verified this session] [OFAC Sanctions Compliance Guidance for the Virtual Currency Industry (Oct 2021)](https://ofac.treasury.gov/media/913571/download?inline)
- For stablecoin issuers specifically, FinCEN and OFAC proposed (Apr 8, 2026) treating permitted payment stablecoin issuers as BSA "financial institutions" with AML/CFT **and sanctions** programs. This does not directly apply to a non-stablecoin, but it signals supervisory expectations. — [Federal Register](https://www.federalregister.gov/documents/2026/04/10/2026-06963/permitted-payment-stablecoin-issuer-anti-money-launderingcountering-the-financing-of-terrorism); [Holland & Knight](https://www.hklaw.com/en/insights/publications/2026/04/fincen-and-ofac-propose-aml-sanctions-rules-for-stablecoin-issuers)

### Inferences
- **To minimize MSB and MTL exposure:**
  - (1) Do not run an issuer-operated buy-back or fiat redemption window.
  - (2) Let third-party exchanges and licensed on/off-ramps handle fiat conversion.
  - (3) If EloCoin is redeemable **only for Tokenelo compute services** (not money), argue it is a user paying for services rather than issuer "redemption" of CVC. Counsel must confirm against FinCEN's issue-and-redeem test and state law (CA "redeemable-asset issuance" and NY "issuing/administering" language).
- **NY and CA risk:** if Tokenelo (a US DevCo) controls minting and distribution to NY or CA residents, BitLicense and DFAL analysis is required. Many projects geo-block NY at the reward-claim level until counsel clears it. BitLicense approval is slow (see Gaps).
- **KYC:** a reward distributor with no fiat touchpoints is not automatically a BSA-regulated MSB. Even so, **OFAC screening of claim wallets and IP geofencing of sanctioned jurisdictions** is baseline practice and effectively mandatory given strict liability. Large reward recipients may also need KYC for tax reporting (see section 8).

### Gaps
- Primary NYDFS rule text on whether issuing a non-redeemable reward token alone is "virtual currency business activity" was not fetched.
- The current DFAL statutory text after SB 97 (whether token issuance or administration is covered) is in conflict and needs counsel.
- BitLicense and DFAL timelines and total cost: no reliable figures found (vendor sites only).

---

## 6. If EloCoin is redeemable for compute or pegged to a unit (stable-value): GENIUS Act vs. commodity rules

### Takeaway
The GENIUS Act (enacted July 18, 2025) governs **payment stablecoins**: tokens the issuer is obligated to redeem for a **fixed amount of monetary value**. A token redeemable for a **fixed quantity of compute** (not dollars) likely falls outside the GENIUS definition. A **dollar-pegged, dollar-redeemable** EloCoin would make Tokenelo a payment stablecoin issuer, requiring a permitted-issuer license, reserves and BSA/sanctions programs. That is not a fast path. Implementing rules are still **proposed**, and the statutory effective date is no later than Jan 18, 2027.

### Cited Findings
- FinCEN and OFAC jointly proposed AML/CFT and sanctions program rules for permitted payment stablecoin issuers (PPSIs) on Apr 8, 2026 (FR Apr 10, 2026), treating PPSIs as BSA financial institutions. Final rules are proposed to take effect 12 months after issuance. — [Federal Register](https://www.federalregister.gov/documents/2026/04/10/2026-06963/permitted-payment-stablecoin-issuer-anti-money-launderingcountering-the-financing-of-terrorism); [WilmerHale](https://www.wilmerhale.com/en/insights/client-alerts/20260420-treasury-announces-proposed-rule-to-implement-the-genius-acts-requirements-to-counter-illicit-finance); [Mayer Brown](https://www.mayerbrown.com/en/insights/publications/2026/04/stable-rules-for-stablecoins-treasury-proposes-aml-and-sanctions-framework-for-issuers)
- One source says final regulations were due by July 18, 2026, with full enforcement no later than **Jan 18, 2027**. I found **no confirmed final GENIUS rule** as of Oct 10, 2026. The OCC issued Bulletin 2026-3 (Feb 25, 2026) on federal qualified payment stablecoin issuers, and the FDIC and Treasury issued proposals in April 2026. — [King & Spalding](https://www.kslaw.com/news-and-insights/stablecoin-issuers-as-banks-fincen-and-ofac-issue-comprehensive-aml-and-sanctions-rules-under-the-genius-act); [Licentium (secondary)](https://www.licentium.io/post/occ-fdic-treasury-propose-genius-act-stablecoin-implementing-rules-august-2026)
- Under the March 2026 SEC taxonomy, "stablecoins" are a separate category governed by the GENIUS Act. — [Weaver](https://weaver.com/resources/crypto-assets-face-clearer-us-rules-under-new-sec-cftc-guidance/); [Dechert](https://www.dechert.com/knowledge/onpoint/2026/3/sec-s-crypto-framework--the-new-token-taxonomy.html)
- GENIUS "payment stablecoin" definition: a digital asset used for payment or settlement, where the issuer is obligated to convert, redeem or repurchase it for a **fixed amount of monetary value** and represents that it will maintain a stable value relative to a fixed amount of monetary value. — [prior knowledge, not re-verified this session] [congress.gov S.1582 GENIUS Act](https://www.congress.gov/bill/119th-congress/senate-bill/1582)

### Inferences
- **Three design options:**
  - **A. Floating EloCoin**, not redeemable by the issuer for anything (pure reward and governance or access): no GENIUS exposure, and the lowest MSB risk.
  - **B. EloCoin redeemable for a fixed amount of compute** (for example, 1 EloCoin = X GPU-seconds or "UCU" units of compute on Tokenelo): likely outside GENIUS because the redemption is not in "monetary value." It resembles a prepaid service credit or "digital tool." Remaining risks: state DFAL "redeemable-asset issuance" language, possible FinCEN prepaid-access or closed-loop analysis, and consumer-protection rules on prepaid credits. Counsel needed.
  - **C. Dollar-pegged or dollar-redeemable EloCoin:** a payment stablecoin requiring PPSI status. This is impractical for a startup and not a fast route.
- **Recommended separation:** a two-token or "points plus credits" design. Keep any stable-value compute credit as an **off-chain, non-transferable account balance** (no trading), and make EloCoin the floating, tradable reward token. This avoids mixing a stable redemption promise into the traded asset.

### Gaps
- Exact final GENIUS definitions and the treatment of non-monetary "unit-pegged" tokens: no primary text fetched. Final OCC, FDIC and Treasury rules were not confirmed.
- Whether a compute-unit-redeemable token is "prepaid access" under FinCEN rules: no source found.

---

## 7. EU MiCA: white paper for "other crypto-assets" (Title II), CASP listing obligations, timelines

### Takeaway
EloCoin would be a Title II "other crypto-asset" under MiCA. A compliant **white paper (Art. 6 + Annex I)** must be **notified to the home Member State authority at least 20 working days before publication**. There is **no prior approval**. It must be published before the offer or admission to trading. Free and reward-based distributions can be exempt *for the offer*, but **admission to trading on an EU CASP still requires a white paper**, from the issuer or from the trading platform under agreement. Since **July 1, 2026**, the CASP transitional period has ended EU-wide, so only MiCA-authorized CASPs can list or serve EU clients.

### Cited Findings
- The white paper must be notified at least **20 working days before publication**, and published before the offer or admission begins. Modifications are notified **7 working days** before publication. — [AMF](https://www.amf-france.org/en/professionals/fintech/my-relations-amf/public-offerings-and-admission-trading-crypto-assets)
- For other crypto-assets, competent authorities may not require prior approval (Art. 8(3)). The offeror, the person seeking admission, or the trading-platform operator notifies the home authority. — [AMF](https://www.amf-france.org/en/professionals/fintech/my-relations-amf/public-offerings-and-admission-trading-crypto-assets); [Walkers (Ireland process)](https://www.walkersglobal.com/en/Insights/2025/09/MiCAR-Title-II-white-paper-notifications-Overview-and-process-in-Ireland)
- Content is prescribed by Article 6 and Annex I. — [A&O Shearman](https://www.aoshearman.com/en/insights/micar-under-the-microscopepart-8-white-paper-vs-prospectus); [micapapers](https://micapapers.com/rules/micar/title-2/)
- **CASP transitional period ended July 1, 2026** EU-wide. Unauthorized CASPs must have completed wind-down. Member States could set shorter periods. — [ESMA statement (Apr 2026)](https://www.esma.europa.eu/sites/default/files/2026-04/ESMA75-113276571-1679_Statement_on_the_end_of_transitional_periods_under_MiCA.pdf); [ESMA public statement (June 2026)](https://www.esma.europa.eu/sites/default/files/2026-06/ESMA75-113276571-1710_Public_Statement_MiCA_transitional_period_ends.pdf); [Harneys](https://www.harneys.com/our-blogs/regulatory/1-july-2026-mica-cut-off-esma-s-statement-on-the-end-of-mica-transitional-periods/)
- **Exemptions for offers (Art. 4).** The white paper requirement does not apply to offers where:
  - (a) the crypto-asset is **offered for free**;
  - (b) it is **automatically created as a reward for maintaining the DLT or validating transactions**;
  - (c) it is a utility token giving access to an existing good or service;
  - (d) it is usable only within a limited merchant network.
  
  Separately, there are size exemptions: fewer than 150 persons per Member State, under €1M over 12 months, or qualified investors only. An offer is **not "free"** if purchasers must provide **personal data** or the offeror receives fees or commissions from holders. **These exemptions do not cover admission to trading (Art. 5).** — [prior knowledge, not re-verified this session] [MiCA Regulation (EU) 2023/1114, EUR-Lex](https://eur-lex.europa.eu/eli/reg/2023/1114/oj); the limited-network carve-out is partially confirmed by [search summary of AMF/commentary](https://www.amf-france.org/en/news-publications/depth/mica)
- One secondary source reports that the Title II white paper rules were not affected by the July 1, 2026 cut-off, and cites an ESMA MiCA review response dated Sept 30, 2026 that I could not verify. — [RegReportingDesk](https://regreportingdesk.com/esma-mica-review-response-casps-token-issuers/)

### Inferences
- **EloCoin's user rewards in the EU** may fit Art. 4(3)(b) (reward for maintaining the DLT or validation) only if earning is genuinely network maintenance or validation work. "Use AI and earn" is more likely to be analyzed as a free offer, and **collecting personal or usage data defeats the "free" exemption**. Plan to **prepare a MiCA white paper regardless**, because EU exchange listing needs one.
- **Fastest EU route:** the issuer (or its EU-facing entity) drafts the Art. 6 white paper and notifies a pragmatic home NCA. Practitioners often cite Ireland (CBI), France (AMF) or another Member State, but counsel must choose. Publish after 20 working days, then list on a MiCA-authorized CASP. Count roughly **4–6 weeks minimum** from a final draft to permissible publication. This is an inference from the 20-working-day rule plus drafting time.
- Liability for white paper content attaches to the offeror or the person seeking admission. EU marketing communications must be consistent with the white paper and identified as such [prior knowledge: MiCA Arts. 7 and 15].
- White papers are reportedly now expected in a machine-readable (iXBRL) format under ESMA's ITS. This is not verified in this session; counsel or the CASP should confirm.

### Gaps
- Primary text of Arts. 4–6, 8 and 15 was not fetched this session (EUR-Lex link provided). Exact wording of the "free" and "reward" exemptions needs verification.
- Required ESMA white paper format (iXBRL/ITS) and its effective date: not verified.
- Which NCAs are fastest or most receptive in practice in 2026, and the cost of a MiCA white paper: no reliable source found.
- Whether the ESMA MiCA review (Sept 2026) proposes changes to Title II: unverified.

---

## 8. Tax: rewards for users (income at receipt), the issuer, and reporting (Form 1099-DA)

### Takeaway
US users who receive EloCoin rewards generally have **ordinary income equal to fair market value when they gain dominion and control**, by analogy to Rev. Rul. 2023-14 (staking) and Notice 2014-21 (mining). That value becomes their basis for later capital gain or loss. **Form 1099-DA** broker reporting covers gross proceeds from 2025 and adds **cost basis for covered assets acquired on or after Jan 1, 2026**. Sources conflict on whether rewards themselves appear on 1099-DA or on 1099-MISC. The issuer's reporting obligations for reward payments need tax counsel.

### Cited Findings
- Staking rewards are ordinary income at FMV when received. Taxation occurs on gaining dominion and control (Rev. Rul. 2023-14). The receipt value becomes basis. — [Reed Corp CPA](https://reedcorp.tax/helpful-guides/crypto/crypto-staking-tax-treatment/); [Kraken](https://www.kraken.com/learn/staking-taxes); [Monaco CPA](https://www.monacocpa.cpa/post/staking-rewards-tax-2026)
- Starting with **2026 transactions**, brokers must report cost basis on Form 1099-DA for covered assets acquired and held in the same broker account on or after Jan 1, 2026. — [Allstate Tax Resolution](https://www.allstatetaxresolution.com/post/crypto-taxes-irs-1099-da-digital-assets); [Coselite](https://coselite.com/blog/crypto-tax-guide-2026)
- **Conflict:** two CPA sources say staking rewards are reported on **1099-MISC**, and that Notice 2024-57 exempts staking from 1099-DA reporting pending guidance. One law blog says 1099-DA covers airdrops, staking and mining income, with a $20,000 threshold. That claim is unverified and an outlier. — [Monaco CPA](https://www.monacocpa.cpa/post/staking-rewards-tax-2026); [Allstate Tax Resolution](https://www.allstatetaxresolution.com/post/crypto-taxes-irs-1099-da-digital-assets)
- No de minimis exception for crypto rewards was identified. — [Kraken](https://www.kraken.com/learn/staking-taxes)
- IRS primary references: Rev. Rul. 2023-14 (staking income on dominion and control); Notice 2014-21 (mined virtual currency is income at FMV on receipt; self-employment tax if a trade or business); Form 1099-DA. — [prior knowledge, not re-verified this session] [Rev. Rul. 2023-14, IRB 2023-33](https://www.irs.gov/irb/2023-33_IRB); [Notice 2014-21](https://www.irs.gov/pub/irs-drop/n-14-21.pdf); [About Form 1099-DA](https://www.irs.gov/forms-pubs/about-form-1099-da)

### Inferences
- **Users:** EloCoin earned for contributing compute or measurement is very likely ordinary income at receipt, and possibly **self-employment income** for heavy "miners" operating as a business (Notice 2014-21 logic). Users face tax before any liquidity, so product UX should show FMV at receipt and offer annual reward statements.
- **Issuer:**
  - (1) Minting tokens is generally not income to the issuer.
  - (2) Token sales (SAFT or pre-sale) produce taxable proceeds, often analyzed as revenue or deferred revenue, or as a prepaid forward, depending on structure.
  - (3) Rewards paid to US persons for services may trigger information reporting (1099-MISC or 1099-NEC above the threshold), which requires collecting **W-9 or W-8** from larger reward recipients.
  - (4) An offshore foundation's distributions to US persons raise withholding and reporting questions.
  
  All of these need tax counsel. The specific reporting thresholds for 2026 were not verified in this session.
- If Tokenelo or an affiliate ever custodies tokens or effects sales for users, it may be a "broker" with 1099-DA obligations. A self-custodial claim flow avoids that.

### Gaps
- IRS primary texts (Notice 2024-57; 1099-DA instructions for 2026) were not fetched. The 1099-DA vs. 1099-MISC treatment of rewards is unresolved here.
- Issuer-side tax treatment of reward emissions (deductibility, valuation of tokens paid for services) and the 2026 1099-MISC/NEC thresholds: not sourced this session.
- Non-US user tax (EU DAC8 reporting began 2026 for CASPs [prior knowledge, unverified]) was not researched.

---

## 9. Typical legal costs, timelines, and entity structures (offshore foundation: Cayman, BVI, Switzerland, Panama; US DevCo): current viability

### Takeaway
The prevailing structure remains a **US DevCo** (equity, team, IP, development under a services contract) plus an **offshore token entity**, most commonly a **Cayman foundation company** (governance, ownerless "orphan" structure) owning a **BVI company** as the token issuer. Switzerland and Liechtenstein remain the "regulated, onshore" alternative, and Panama or the Marshall Islands are cost-driven options. The 2026 US shift (March interpretation; SEC rhetoric about bringing crypto onshore) makes a **US-only issuer more feasible than in 2023–24**, but without CLARITY the offshore wrapper still matters for non-US listings and MiCA. Reliable legal-cost figures were **not** found. Vendor estimates range from $5k to $200k+ for setup and are untrustworthy.

### Cited Findings
- Common pattern: a Cayman foundation for governance owning a BVI company for token issuance. The foundation has no shareholders ("orphan" structure). An onshore "labs/DevCo" writes the software under a contractual relationship. — [Legal Nodes](https://www.legalnodes.com/article/cayman-foundation-bvi-company-token-launches); [DAO SPV blog](https://blog.daospv.com/crypto-catamaran-why-when-and-how-to-use-the-bvi-cayman-structure-for-token-issuance/)
- The **Cayman Virtual Asset (Service Providers) Act** can apply to issuers that issue or exchange tokens **for consideration**. — [Lexology (Cayman/BVI)](https://www.lexology.com/library/detail.aspx?g=90e058b4-bff3-46c7-8111-86c3be3e701b); [Mondaq](https://www.mondaq.com/caymanislands/fin-tech/1597602/cayman-foundations-for-token-issuance-web-3-key-facts)
- Utility-token issuance in Cayman, BVI and Panama is described as generally "non-regulated." Switzerland, Liechtenstein and Singapore are "regulated" routes requiring token authorization. This comes from a service-provider source. — [Legal Nodes utility token guide](https://www.legalnodes.com/article/utility-token-launch-legal-guide)
- Cayman foundation bylaws are easier to amend than Swiss foundation bylaws. Cayman costs are "moderate to high"; BVI incorporation is cheaper. — [Legal Nodes](https://www.legalnodes.com/article/cayman-foundation-bvi-company-token-launches); [Spindipper](https://spindipper.com/guides/crypto-structures-and-compliance/cayman-foundation-vs-bvi-company)
- One 2026 guide favors a Marshall Islands DAO LLC with a UAE treasury entity for some issuers. This is promotional. — [NeoLegal](https://neolegal.ae/insights/offshore-token-issuance-bvi-cayman-marshall-panama)
- Legal cost estimates conflict widely (initial opinion $5k–$20k; setup $15k–$200k+). All come from **vendor marketing blogs** and are unreliable. — [Disence](https://disence.com/articles/token-launch-cost-in-2026-what-to-expect-today); [Sherlock](https://sherlock.xyz/post/how-to-launch-a-crypto-token-in-2026-the-complete-playbook)
- Tier-1 CEX listing fees are opaque. Vendor estimates run $300k–$500k (OKX) and up to $850k (Binance), and many venues request a **legal opinion** on token classification. — [Motiontrade](https://www.motiontrade.com/blog/how-much-does-it-cost-to-list-a-token-on-a-crypto-exchange-in-2026); [TokenMarketMaker](https://www.tokenmarketmaker.io/cex-token-listing-requirements-2026/)

### Inferences
- **Recommended structure (to be validated by counsel):**
  - **EloAI Inc. (US DevCo):** equity investors, team, IP. It licenses software to the foundation under an arm's-length development and services agreement and avoids controlling token emissions.
  - **Cayman foundation company:** token governance, treasury and grants, owning a **BVI token issuer**. Distribute rewards via smart contract to minimize "consideration" (which triggers the Cayman VASP Act) and to minimize "central party" control (which matters for US digital-commodity status).
  - **An EU entity is not required** for a Title II white paper. The offeror can be non-EU, but notification goes to the home NCA. Confirm with EU counsel.
  - **Wyoming DUNA** is an emerging US alternative to offshore governance wrappers [prior knowledge, unverified this session]. Its viability post-2026 needs counsel review.
- **Budget planning:** with no reliable public figures found, treat cost as a counsel-quote item. Major line items:
  - US securities and commodities opinion or memo and token design review
  - An optional SEC no-action request
  - Foundation plus BVI formation and annual fees
  - MiCA white paper drafting and notification
  - Tax structuring
  - FinCEN, state MTL and BitLicense analysis
  - Exchange listing legal opinions
  - Ongoing compliance (OFAC/KYC vendor)
- **Timeline anchors from the sources:**
  - MiCA notification: at least 20 working days.
  - Reg Crypto Assets: comments due Oct 20, 2026; final rule no earlier than about Q1 2027.
  - CLARITY: not before the lame duck (late 2026) and likely 2027 or later.
  - DFAL: license or application required now.
  - No-action letters: Fuse submitted Nov 19 and was granted in Nov 2025, which suggests staff can move quickly *when pre-cleared informally*. That is my inference; the pre-filing process is not documented in the sources.

### Gaps
- No authoritative (law firm or bar survey) 2026 cost figures for token launches, MiCA white papers, Cayman foundations, BitLicense or DFAL.
- Swiss (FINMA) 2026 practice and Panama's current viability: not researched in depth.
- Coinbase and Kraken US listing requirements and processes post-March-2026: not found.

---

## 10. Recent enforcement and precedent relevant to reward / compute / DePIN tokens

### Takeaway
The trend since 2025 is **de-escalation** for network-reward tokens. The SEC dismissed its unregistered-offering case against **Nova Labs (Helium: HNT/MOBILE/IOT)** with prejudice in April 2025, while settling a **fraud** claim (misrepresented partnerships) for $200k. It then granted DePIN no-action letters (DoubleZero, Fuse). The surviving enforcement exposure is **fraud and misrepresentation**, which antifraud rules still cover under every proposed exemption, and CFTC manipulation. I found no 2026 enforcement action against a reward or compute token in this session.

### Cited Findings
- The SEC dismissed its case against Nova Labs, which alleged that distributing HNT, MOBILE and IOT were unregistered securities offerings, **with prejudice** (April 2025). Helium characterizes this as meaning that selling hardware and distributing tokens for network growth does not automatically create securities. That is Helium's characterization; there was no merits ruling. — [Helium blog](https://www.helium.com/blog/sec-dismisses-case-nova-labs-helium); [The Defiant](https://thedefiant.io/news/regulation/sec-dismisses-lawsuit-against-nova-labs-affirms-hnt-mobile-iot-tokens-securities-97c0bcf9)
- Nova Labs agreed to pay **$200,000** to settle charges that it misled investors about brand partnerships, neither admitting nor denying. — [CoinDesk](https://www.coindesk.com/policy/2025/04/10/helium-issuer-nova-labs-agrees-to-pay-sec-usd200k-to-settle-allegations-it-lied-to-investors-about-brand-partnerships)
- DePIN no-action relief: DoubleZero (Sept 29, 2025) and Fuse (Nov 2025). — [Sumsub](https://sumsub.com/media/news/sec-declares-depin-tokens-outside-jurisdiction/); [Cointelegraph](https://cointelegraph.com/news/sec-no-action-letter-fuse-depin-project)
- Under proposed Reg Crypto Assets, issuers remain subject to antifraud and antimanipulation provisions. — [Journal of Accountancy](https://www.journalofaccountancy.com/news/2026/aug/sec-proposal-aims-to-clarify-securities-rules-for-crypto-assets/)
- Older precedents (pre-2025, still cited by private plaintiffs): SEC v. LBRY (2022, "utility" token sold by issuer held a security), SEC v. Kik (2020), SEC v. Telegram (2020). — [prior knowledge, not re-verified this session; no URL fetched]

### Inferences
- The SEC's posture has changed, but **private securities class actions and state regulators** can still argue Howey. The proposed safe harbor expressly does not bind other parties. Issuer token sales and marketing remain the litigation surface.
- Nova Labs shows that **misstatements about partnerships or traction** are the enforcement risk that survives. EloAI's claims about AI-compute measurement accuracy, partners and usage metrics should be substantiated.

### Gaps
- No 2026 SEC, CFTC or DOJ crypto enforcement actions against token issuers were located in this session. The pace of fraud-focused enforcement under the current SEC is unquantified here.
- State attorney-general or private class action activity against reward tokens in 2025–2026 was not researched.

---

## 11. Synthesis: fastest compliant route to exchange trading (as of Oct 2026)

### Takeaway
The fastest defensible route is a **no-sale, programmatic "network reward" launch**, structured like DePIN or mining rather than a task-based airdrop. Run it through an **offshore foundation/BVI issuer** with a **US DevCo**. Avoid an issuer-run fiat redemption window and any stable-value peg. Raise capital only via **Reg D/Reg S** with lockups. Produce a **MiCA white paper** for EU venues. List first on DEXs or non-US CEXs, then on US platforms once a counsel memo maps EloCoin onto the March 2026 taxonomy. Optionally seek a **DoubleZero/Fuse-style no-action letter**, and file comments on Reg Crypto Assets by **Oct 20, 2026**.

### Cited Findings
- Non-sale programmatic network rewards have staff no-action support (DoubleZero, Fuse), and mining and staking rewards are treated as not securities transactions. — [Sumsub](https://sumsub.com/media/news/sec-declares-depin-tokens-outside-jurisdiction/); [Cointelegraph](https://cointelegraph.com/news/sec-no-action-letter-fuse-depin-project); [DLA Piper](https://www.dlapiper.com/en-us/insights/publications/2026/03/sec-and-cftc-issue-interpretive-release-on-crypto)
- Task-based distributions are excluded from the covered-airdrop conclusion. — [DLA Piper](https://www.dlapiper.com/en-us/insights/publications/2026/03/sec-and-cftc-issue-interpretive-release-on-crypto)
- No statute (CLARITY failed cloture Sept 15, 2026) and no final SEC exemption (Reg Crypto Assets comments due Oct 20, 2026). — [CNBC](https://www.cnbc.com/2026/09/15/senate-cloture-vote-on-clarity-act-fails-dealing-regulatory-setback-to-crypto-industry.html); [Federal Register](https://www.federalregister.gov/documents/2026/08/21/2026-17183/regulation-crypto-assets)
- Issue-and-redeem control triggers FinCEN money-transmitter status. — [FinCEN 2019](https://www.fincen.gov/system/files/2019-05/FinCEN%20CVC%20Guidance%20FINAL.pdf)
- A MiCA white paper must be notified at least 20 working days before publication, and only MiCA-authorized CASPs can operate after July 1, 2026. — [AMF](https://www.amf-france.org/en/professionals/fintech/my-relations-amf/public-offerings-and-admission-trading-crypto-assets); [ESMA](https://www.esma.europa.eu/sites/default/files/2026-06/ESMA75-113276571-1710_Public_Statement_MiCA_transitional_period_ends.pdf)
- Many CEXs request a legal opinion on token classification at listing. — [TokenMarketMaker](https://www.tokenmarketmaker.io/cex-token-listing-requirements-2026/)

### Inferences
**Step list (all items require counsel sign-off):**
1. **Token design (weeks 0–4).**
   - Rewards are paid for objectively measured compute contribution or verification, using a published formula and on-chain emissions.
   - No purchase is required to earn; flag usage-rebate mechanics for counsel.
   - No yield, buybacks or price promises.
   - Insider and treasury caps below the 20% House threshold to preserve CLARITY optionality.
   - A separate, non-transferable compute-credit balance if a stable redemption is needed.
2. **Entities (weeks 0–8).** Cayman foundation plus BVI issuer, a US DevCo services agreement, and a token-allocation policy.
3. **US legal memo** mapping EloCoin to "digital tool" or DePIN-reward treatment under the March 2026 interpretation. Optionally, a **no-action request** (timeline unknown).
4. **Capital.** Reg D 506(c) and Reg S SAFT or token warrants with lockups. No public sale to US persons.
5. **Compliance stack.**
   - OFAC wallet screening and geofencing (sanctioned countries; consider NY and CA pending BitLicense/DFAL analysis).
   - W-9/W-8 collection above reward thresholds.
   - No issuer fiat redemption.
6. **EU.** Draft the Art. 6 white paper, notify the home NCA, wait 20 working days, publish, then list on MiCA-authorized CASPs.
7. **Listing sequence.**
   - DEX liquidity (issuer not operating the pool, or market-maker agreements with anti-manipulation terms).
   - Non-US and EU CEXs with the white paper.
   - US venues once the memo is accepted by their listing committees.
8. **Monitor.** Reg Crypto Assets final rule (≥Q1 2027), CLARITY lame duck or 2027 reintroduction, CFTC CTX/CAM rulemaking, GENIUS final rules (effective by Jan 18, 2027), and DFAL regulations.

### Gaps
- No source quantified the real-world timeline from token generation event to a US CEX listing (for example, Coinbase) under the 2026 regime.
- No source addressed how US exchanges' listing committees apply the March 2026 taxonomy to new, centrally distributed reward tokens.

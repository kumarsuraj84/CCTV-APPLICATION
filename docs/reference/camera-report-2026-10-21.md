# CityKart CCTV Hub: Camera Health Report

Source: Camera Report page at http://10.0.0.141:8000/. Last automated check: **21 Oct 2026, ~11:20–11:21 am IST** (the page was read at about 3:30 pm, so this is a morning snapshot and not a live check).

## Summary

| Metric | Value |
|---|---|
| Stores | 215 |
| Total cameras | 4,609 |
| Live | 3,849 (83.5%) |
| Offline | 760 (16.5%) |
| Pending check | 0 |
| Stores with NVR down | 4 |
| Stores with all cameras live | 111 |
| Stores with some cameras offline | 73 |
| Stores with **all** cameras offline | 31 |

## NVR down (4 stores)

| Store | City | Zone | Cameras |
|---|---|---|---|
| MDB | Madhubani | BR | 24 |
| PMT | Machuatoli | BR | 24 |
| BRD | Bahraich-Rupaidiha | UP | 16 |
| SPL | Supaul | BR | 16 |

## Stores with 0 live cameras (31)

Both the NVR and the stores marked "NVR down" are included. Most of the 27 stores whose NVR is up still show 0%, so this is more likely a stream or network-path problem than a failed NVR. That is a hypothesis to confirm.

| Store | City | Zone | Cameras | NVR |
|---|---|---|---|---|
| MTH | Motihari | BR | 28 | Up |
| BAR | Buxar | BR | 24 | Up |
| BBR | Ballia_Belthara_Road | UP | 24 | Up |
| BIA | Ballia | UP | 24 | Up |
| GRD | Giridih | Jharkhand | 24 | Up |
| GWT | Guwahati | Assam | 24 | Up |
| KGN | Kanpur | UP | 24 | Up |
| KMC | Katihar-2 | BR | 24 | Up |
| LAD | Adilnagar | UP | 24 | Up |
| LAM | LKO-Alambagh | UP | 24 | Up |
| LMP | LKO-Munshipulia | UP | 24 | Up |
| MDB | Madhubani | BR | 24 | **Down** |
| PMT | Machuatoli | BR | 24 | **Down** |
| PTS | Patna-Phulwarisharif | BR | 24 | Up |
| SDH | Siddhi | MP | 24 | Up |
| TNS | Tinsukia | Assam | 24 | Up |
| VLP | Varanasi | UP | 24 | Up |
| VRS | Varanasi-2 | UP | 24 | Up |
| AMP | Ambikapur | CH | 16 | Up |
| BLA | Ballia | UP | 16 | Up |
| BRD | Bahraich-Rupaidiha | UP | 16 | **Down** |
| GBG | Gorakhpur | UP | 16 | Up |
| GSD | Ghazipur_Saidpur | UP | 16 | Up |
| JCL | Jhansi | UP | 16 | Up |
| LPR | Lakhimpur | UP | 16 | Up |
| LTL | LKO-Telibagh | UP | 16 | Up |
| NDA | Nawada | BR | 16 | Up |
| NTV | Nautanwa | UP | 16 | Up |
| SHR | Siwan-2 | BR | 16 | Up |
| SPL | Supaul | BR | 16 | **Down** |
| SSR | Allahabad-Sulemsarai | UP | 16 | Up |

Subtotal: 644 cameras offline in these 31 stores. The other 116 offline cameras are in the 73 partially-offline stores below.

## Stores with some cameras offline (73)

Format: store, live/total.

**Largest gaps**
- PDR 5/13
- PLB 9/12
- ABD 13/16
- BSK 14/16
- FBD 14/16
- GPG 15/16
- SLC 22/28
- DLS 20/24
- CHB 21/24
- CTA 21/24
- DHI 21/24
- DPT 21/24
- SRA 19/22
- RSG 21/23
- HO 27/30
- AAC 19/20

**Two cameras offline**
- BGI 22/24
- BHI 22/24
- DTG 22/24
- JGD 22/24
- KDR 22/24
- MAR 22/24
- NAH 22/24
- PAR 22/24
- SSN 22/24

**One camera offline (23/24 unless noted)**
BAC, BDG, BHR, BLR, BPC, BSC, CPR (24/25), DBR, DRG, GNM, HRD, JBP, JDP, KGP, LBK, LMD, LMT, MCR, MNP, MNR, MPR, MZM, NGZ, PBM, PBS, PKM, PKR, PNA (25/26), REW, RKT, RLN, SBA, SBP, SVP, SWN, UBS, UDP, VRN

**One camera offline (15/16)**
GPG, HJD, JGB, NGC, PBA, PHR, RGA, SGT, SKP, SMB, TGR

## Observations

- **31 stores (14% of the network) show zero live cameras.** Many are UP and BR stores, which suggests a regional network or VPN issue worth checking first.
- Almost all 760 offline cameras are in the 31 fully-dark stores (644, or 85%). The other 116 are scattered single-camera failures.
- AAC (Ambikapur), checked live earlier, showed camera 12 (AACCC) failing with "mse: streams: wrong response on DESCRIBE" while the report counts 19/20 live, which is consistent.
- Data hygiene: state labels are inconsistent (JH and Jharkhand, ASSAM and Assam), and CPR (25), PNA (26), RSG (23), SLC (28), MTH (28), PDR (13), PLB (12) and HO (30) have non-standard camera counts.

## Caveats

- The status comes from the hub's own report. I did not trigger a fresh scan ("अभी जाँचें"), because that probes every NVR, so rerun it before acting on this.
- I did not open each of the 215 stores' live grids. The report is the hub's own assessment of all cameras.

# IES Hub — Owners

Until ported inside the GXO firewall, the IES Hub is maintained by a single
primary owner. Once ported, this file should be updated to reflect the IT /
platform team's ownership model.

## Primary owner

- **Brock Eckles** (`brockeckles@gmail.com`) — Solutions Design lead, GXO IES

## Areas of responsibility

The single-owner model means everything routes to Brock today. The list
below records *intended* ownership so the post-port handoff is clearer.

| Area                              | Today  | Post-port (suggested)          |
|-----------------------------------|--------|--------------------------------|
| Cost Model engine + UI            | Brock  | IES Engineering Lead           |
| Warehouse Sizing engine + UI      | Brock  | IES Engineering Lead           |
| MOST / Labor                      | Brock  | IES Labor SME                  |
| NetOpt / COG / Fleet              | Brock  | IES Logistics Engineering Lead |
| Cost Model rate cards / Pricing   | Brock  | IES Commercial Lead            |
| Deal Management / DOS workflow    | Brock  | IES Operations PM              |
| Training Wiki content             | Brock  | IES Operations PM              |
| Hub frontend infra                | Brock  | GXO IT (Platform)              |
| Supabase / DB schema              | Brock  | GXO IT (Data) + IES SME        |
| Authentication / RLS / Admin      | Brock  | GXO IT (Security) + IES        |
| Analytics + Audit                 | Brock  | GXO IT (Data) + IES            |
| Tests / CI                        | Brock  | GXO IT (Platform)              |

## Escalation

For questions inside the firewall, route to the GXO IT contact owning the
deployed environment. For domain questions (cost-model methodology, MOST
templates, DOS stage definitions, etc.) route to the IES SME named in the
table above.

## Contributing

Until inside-the-firewall change-control is in place, contributions land via
direct push to `main` after the pure test suite passes. After the port,
change-control follows the GXO IT process.

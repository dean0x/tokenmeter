// Child process probe for the local time zone. The test sets TZ for this process
// only. It prints today and the month for the instant in argv[2] (epoch ms).

import { localZone, monthPeriod, todayPeriod } from "../../src/periods.ts";

const nowMs = Number(process.argv[2]);
const zone = localZone();
process.stdout.write(JSON.stringify({ today: todayPeriod(zone, nowMs), month: monthPeriod(zone, nowMs) }));

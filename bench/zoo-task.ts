// The complex zoo task and its checks, shared by zoo-agent.ts (one run) and parallel.ts (several at once).
const next = new Date();
next.setDate(1);
next.setMonth(next.getMonth() + 1);
export const wantDate = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-15`;

export const PROMPT = `Go to http://localhost:4545/zoo and complete the account setup:
- preferred language Python3, country of residence Canada, seniority Senior
- start date: the 15th of next month
- subscribe the newsletter with test@example.com
- apply coupon SAVE10, and save the card holder name Test User
- write the message "Hello there"
- turn on email notifications
- billing email bill@acme.co (Billing tab), postal code 560001 (Shipping address)
- open Account > Settings
- open Project 42 in the projects list
- generate the report and download it
- mobile number 5551234567, monthly budget 70, work mode Hybrid, timezone India, company name Acme Robotics
- primary skill TypeScript
- search members for "ana"
- choose the Team plan, agree to the terms and continue to payment
Do not archive anything and do not open the chat. Report what you did.`;

type Zoo = Record<string, unknown>;

export const EXPECT: [string, (z: Zoo) => boolean][] = [
  ["language", (z) => z.lang === "Python3"],
  ["country", (z) => z.country === "Canada"],
  ["seniority", (z) => z.level === "Senior"],
  ["date", (z) => z.date === wantDate],
  ["newsletter", (z) => z.newsletter === "test@example.com"],
  ["coupon (iframe)", (z) => z.coupon === "SAVE10"],
  ["card holder (x-origin iframe)", (z) => z.cardHolder === "Test User"],
  ["message", (z) => z.message === "Hello there"],
  ["notifications", (z) => z.notifications === true],
  ["billing email", (z) => z.billingEmail === "bill@acme.co"],
  ["postal code", (z) => z.zip === "560001"],
  ["hover menu", (z) => z.menu === "Settings"],
  ["project 42", (z) => z.project === 42],
  ["download", (z) => z.downloaded === true],
  ["phone", (z) => z.phone === "5551234567"],
  ["budget", (z) => z.budget === 70],
  ["work mode", (z) => z.workMode === "Hybrid"],
  ["timezone", (z) => String(z.tz).includes("India")],
  ["company", (z) => z.company === "Acme Robotics"],
  ["skill", (z) => z.skill === "TypeScript"],
  ["search", (z) => z.search === "ana"],
  ["plan", (z) => String(z.plan).startsWith("Team")],
  ["terms + continue", (z) => z.accepted === true],
  ["did NOT archive", (z) => !z.archived],
  ["did NOT open chat", (z) => !z.chat],
];

// The names of the checks that failed for what a page recorded.
export function failures(z: Zoo): string[] {
  return EXPECT.filter(([, ok]) => !ok(z)).map(([name]) => name);
}

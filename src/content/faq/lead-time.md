---
question: "How far ahead do I have to order?"
slug: "lead-time"
group: "ordering"
order: 2
short: "At least {leadDays} {leadWord}. Orders for a bake date close at {cutoffLabel}, {cutoffDays} {cutoffWord} before that date."
seoTitle: "How far ahead to order a tray"
metaDescription: "At least {leadDays} {leadWord}. Orders for a bake date close at {cutoffLabel}, {cutoffDays} {cutoffWord} before it, which is when the ingredients get bought."
related:
  - "pickup"
---

At least <span class="tabular">{leadDays}</span> {leadWord}. Orders for a bake
date close at <span class="tabular">{cutoffLabel}</span>,
<span class="tabular">{cutoffDays}</span> {cutoffWord} before that date, which
is when the ingredients get bought and the batch gets scheduled.

{bakeDaysSentence} {if:storeOpen}The picker shows the dates that are actually open, and a full date shows as full there rather than as an error at payment.{else}When ordering opens, the picker will show the dates that are actually open rather than every date on the calendar.{end}

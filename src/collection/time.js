const ZONE = 'America/Los_Angeles';
const ptDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});
const ptHour = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE, hour: '2-digit', hourCycle: 'h23',
});

export function localDay(timestamp = Date.now()) {
  const parts = Object.fromEntries(ptDate.formatToParts(new Date(timestamp)).map(p => [p.type, p.value]));
  return parts.year + '-' + parts.month + '-' + parts.day;
}

export function localHour(timestamp = Date.now()) {
  return Number(ptHour.format(new Date(timestamp)));
}

export function isMorningCollectionTime(timestamp) {
  return localHour(timestamp) === 8;
}

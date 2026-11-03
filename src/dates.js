export function ago(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

export function addDate(url, prefix, iso) {
  const [year, month, day] = iso.split("-");
  url.searchParams.set(prefix + ".year", year);
  url.searchParams.set(prefix + ".month", String(Number(month)));
  url.searchParams.set(prefix + ".day", String(Number(day)));
}

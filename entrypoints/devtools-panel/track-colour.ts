/** Tracks cycle through the six identity colours in style.css. */
export function trackColourClass(colorIndex: number): string {
  return `track-colour track-colour--${colorIndex % 6}`
}

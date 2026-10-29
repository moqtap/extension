/**
 * DevTools page — creates the "WebTransport Inspector" panel.
 *
 * This runs once when DevTools opens for a tab. It registers a panel
 * that loads the devtools-panel Vue app.
 */

// Firefox shows the icon on the toolbox tab, beside its monochrome tool icons.
const icon = import.meta.env.FIREFOX ? '/icon/panel.svg' : ''

// WXT generates the correct path for the panel HTML
browser.devtools.panels.create('WebTransport', icon, 'devtools-panel.html')

/**
 * DevTools page — creates the "WebTransport Inspector" panel.
 *
 * This runs once when DevTools opens for a tab. It registers a panel
 * that loads the devtools-panel Vue app.
 */

// WXT generates the correct path for the panel HTML
chrome.devtools.panels.create('WebTransport', '', 'devtools-panel.html')

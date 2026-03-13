// src/core/integrationHandlers.js
// Stub handlers for POS webhook events — expand as integration grows.

export async function handleZenotiEvent(salonId, event) {
  console.log(`[Zenoti] Event received for salon ${salonId}:`, event?.type || "unknown");
  // TODO: handle appointment.booked, appointment.cancelled, etc.
}

export async function handleVagaroEvent(salonId, event) {
  console.log(`[Vagaro] Event received for salon ${salonId}:`, event?.type || "unknown");
  // TODO: handle vagaro webhook events
}

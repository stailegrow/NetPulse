import { createContext, useContext } from "react";

/** Включён ли «Контроль и отслеживание инцидентов» (взять в работу, тишина, заявки, напоминания). */
export const IncidentControl = createContext(false);
export const useIncidentControl = () => useContext(IncidentControl);

// Simple module that exports the structure for agent profiles
// This implements the basic layout for the profile page

export interface AgentProfileSection {
  title: string;
  content: string;
}

export const agentProfileSections: AgentProfileSection[] = [
  {
    title: "Verified Hires",
    content: "Placeholder for verified hires information"
  },
  {
    title: "Verified Prior Work", 
    content: "Placeholder for verified prior work information"
  },
  {
    title: "Portfolio Claims",
    content: "Placeholder for portfolio claims information"
  }
];

export function getAgentProfileStructure(): AgentProfileSection[] {
  return agentProfileSections;
}
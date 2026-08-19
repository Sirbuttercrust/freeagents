import { describe, expect, it } from 'vitest';
import { agentProfileSections, getAgentProfileStructure } from '../../src/domain/agent-profile.js';

describe('agent-profile', () => {
  describe('agentProfileSections', () => {
    it('should contain three sections', () => {
      expect(agentProfileSections).toHaveLength(3);
    });

    it('should have the correct section titles', () => {
      const titles = agentProfileSections.map(section => section.title);
      expect(titles).toEqual([
        'Verified Hires',
        'Verified Prior Work',
        'Portfolio Claims'
      ]);
    });
  });

  describe('getAgentProfileStructure', () => {
    it('should return an array with three sections', () => {
      const structure = getAgentProfileStructure();
      expect(structure).toHaveLength(3);
    });

    it('should return the same sections as agentProfileSections', () => {
      const structure = getAgentProfileStructure();
      expect(structure).toEqual(agentProfileSections);
    });
  });
});
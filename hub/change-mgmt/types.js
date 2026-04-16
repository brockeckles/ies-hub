/**
 * IES Hub v3 — Change Management Types
 * JSDoc typedefs for change initiatives, milestones, stakeholders, and communications.
 *
 * @module hub/change-mgmt/types
 */

/**
 * @typedef {Object} ChangeInitiative
 * @property {string} id
 * @property {string} title
 * @property {string} description
 * @property {'planning' | 'in-progress' | 'completed' | 'on-hold'} status
 * @property {'low' | 'medium' | 'high' | 'critical'} priority
 * @property {string} owner — person responsible
 * @property {string} startDate — ISO date
 * @property {string} targetDate — ISO date
 * @property {string[]} tags
 * @property {Milestone[]} milestones
 * @property {Stakeholder[]} stakeholders
 * @property {Communication[]} communications
 * @property {string} [created_at]
 * @property {string} [updated_at]
 */

/**
 * @typedef {Object} Milestone
 * @property {string} id
 * @property {string} title
 * @property {string} dueDate — ISO date
 * @property {'pending' | 'completed' | 'overdue'} status
 * @property {string} [completedDate]
 */

/**
 * @typedef {Object} Stakeholder
 * @property {string} id
 * @property {string} name
 * @property {string} role
 * @property {'champion' | 'supporter' | 'neutral' | 'resistant'} sentiment
 * @property {'high' | 'medium' | 'low'} influence
 * @property {string} [notes]
 */

/**
 * @typedef {Object} Communication
 * @property {string} id
 * @property {string} title
 * @property {'email' | 'meeting' | 'training' | 'announcement' | 'workshop'} type
 * @property {string} date — ISO date
 * @property {string} audience — target group
 * @property {'planned' | 'sent' | 'completed'} status
 * @property {string} [notes]
 */

/**
 * @typedef {Object} InitiativeStats
 * @property {number} totalInitiatives
 * @property {number} activeInitiatives
 * @property {number} completedInitiatives
 * @property {number} totalMilestones
 * @property {number} completedMilestones
 * @property {number} overdueMilestones
 * @property {number} totalStakeholders
 * @property {number} championCount
 * @property {number} resistantCount
 * @property {number} totalCommunications
 * @property {number} plannedCommunications
 */

/**
 * @typedef {Object} ReadinessScore
 * @property {number} overall — 0-100
 * @property {number} milestoneScore — 0-100
 * @property {number} stakeholderScore — 0-100
 * @property {number} communicationScore — 0-100
 * @property {'red' | 'yellow' | 'green'} rating
 */

/**
 * @typedef {Object} TimelineEvent
 * @property {string} date — ISO date
 * @property {string} title
 * @property {'milestone' | 'communication' | 'start' | 'target'} type
 * @property {string} initiativeId
 * @property {'pending' | 'completed' | 'overdue' | 'planned' | 'sent'} status
 */

export {};

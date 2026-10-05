/**
 * The isolated fixture's Storybook configuration. The project stays self-contained: it declares
 * only its stories and the HTML framework, and it never imports Nexus product code.
 */
export default {
  stories: ['../stories/**/*.stories.js'],
  framework: { name: '@storybook/html-vite', options: {} },
};

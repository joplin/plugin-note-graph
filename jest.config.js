/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',

    roots: ['<rootDir>/src'],

    testMatch: ['**/*.test.ts'],

    moduleFileExtensions: ['ts', 'js', 'json'],

    moduleNameMapper: {
        '^api$': '<rootDir>/src/tests/mocks/joplin.ts',
    },

    clearMocks: true,

    collectCoverageFrom: [
        'src/**/*.ts',
        '!src/index.ts',
        '!src/**/*.d.ts',
        '!src/tests/**',
    ],
};
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import App from './App';
import api from './api';

// Mock the Axios API
jest.mock('./api');

describe('Search Race Condition', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('ignores stale responses when search and page change rapidly', async () => {
        let resolveStaleRequest;
        let resolveFreshRequest;

        // Mock API to return two controlled promises
        api.get
            .mockImplementationOnce(() => new Promise(resolve => { resolveStaleRequest = resolve; }))
            .mockImplementationOnce(() => new Promise(resolve => { resolveFreshRequest = resolve; }));

        render(<App />);

        // 1. Initial mount triggers the first API call (Stale Request)
        expect(resolveStaleRequest).toBeDefined();

        // 2. Simulate typing in the desktop search bar
        const searchInput = screen.getByPlaceholderText('Search...');
        
        act(() => {
            fireEvent.change(searchInput, { target: { value: 'New Search' } });
            // Advance timers by 500ms to clear the debounce and trigger the second fetch
            jest.advanceTimersByTime(500); 
        });

        // 3. The debounced effect has run, triggering the second API call
        expect(resolveFreshRequest).toBeDefined();

        // 4. Simulate the fast second request resolving FIRST
        await act(async () => {
            resolveFreshRequest({
                data: { products: [{ _id: '1', name: 'Fresh Search Result' }], pages: 1, total: 1 }
            });
        });

        // 5. Simulate the slow first request resolving LAST
        await act(async () => {
            resolveStaleRequest({
                data: { products: [{ _id: '2', name: 'Stale Old Result' }], pages: 1, total: 1 }
            });
        });

        // 6. Verify the UI respects the correct fresh request and ignores the stale one
        await waitFor(() => {
            expect(screen.getByText('Fresh Search Result')).toBeInTheDocument();
        });
        
        expect(screen.queryByText('Stale Old Result')).not.toBeInTheDocument();
    });
});
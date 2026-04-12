// Auth.js - Updated

// Server health check
async function checkServerHealth() {
    try {
        const response = await fetch('/health');
        if (!response.ok) throw new Error('Server is down');
        return await response.json();
    } catch (error) {
        console.error('Health check failed:', error);
        throw error;
    }
}

// Improved error handling for login
async function login(username, password) {
    try {
        const response = await fetch('/login', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({username, password}),
        });
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || 'Login failed');
        }
        return await response.json();
    } catch (error) {
        console.error('Login error:', error);
        throw error;
    }
}
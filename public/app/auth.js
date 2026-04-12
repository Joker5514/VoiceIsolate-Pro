const auth = {
    // Existing functionality for session persistence, user badge rendering, license manager integration, and logout handling

    // Function to check server health
    _checkServerHealth: async function() {
        try {
            const response = await fetch('/api/health', { method: 'GET', timeout: 5000 });
            return response.ok;
        } catch (error) {
            console.error('Server health check failed:', error);
            return false;
        }
    },

    // Function to provide detailed error message
    _getDetailedErrorMessage: function() {
        if (!navigator.onLine) {
            return 'No internet connection. Please check your network settings.';
        }
        return 'Server is currently unreachable. Please try again later.';
    },

    // Updated login function
    _handleLogin: async function() {
        const loginButton = document.getElementById('loginButton');
        loginButton.textContent = 'Checking server...';

        const serverHealthy = await this._checkServerHealth();
        if (!serverHealthy) {
            alert(this._getDetailedErrorMessage());
            return;
        }

        loginButton.textContent = 'Signing in...';
        // Proceed with existing login logic
        // ...
    },

    // Other auth methods continue here...
};

export default auth;
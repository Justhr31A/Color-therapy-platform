import axios from 'axios';

const baseURL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

const api = axios.create({
  baseURL: `${baseURL}/api`,
  withCredentials: true, // send/receive the httpOnly auth cookie
  headers: { 'Content-Type': 'application/json' },
});

// Normalize errors so callers can just do `catch (err) { setError(err.message) }`
api.interceptors.response.use(
  (res) => res,
  (err) => {
    const message = err.response?.data?.error || err.message || 'Something went wrong.';
    const error = new Error(message);
    // Additive: callers that only read `.message` are unaffected. `details` carries e.g. the list of publish-validation problems.
    error.status = err.response?.status;
    error.code = err.response?.data?.code;
    error.details = err.response?.data?.details;
    return Promise.reject(error);
  }
);

export default api;
export { baseURL };

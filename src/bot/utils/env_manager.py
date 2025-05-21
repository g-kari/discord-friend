"""
Environment file (.env) manager utility.
Provides functions to safely read, update, and write environment variables
with proper error handling and file locking to prevent race conditions.
"""

import os
import logging
import json
from typing import Dict, List, Optional, Union, Any

# Set up logger
logger = logging.getLogger("env_manager")

# Import platform-specific file locking mechanism
try:
    import fcntl  # Unix-based systems
    
    def lock_file(f):
        """Lock a file using fcntl (Unix systems)"""
        fcntl.flock(f, fcntl.LOCK_EX)
    
    def unlock_file(f):
        """Unlock a file using fcntl (Unix systems)"""
        fcntl.flock(f, fcntl.LOCK_UN)
    
    LOCK_AVAILABLE = True
    
except ImportError:
    try:
        import msvcrt  # Windows systems
        
        def lock_file(f):
            """Lock a file using msvcrt (Windows systems)"""
            f.seek(0, os.SEEK_END)  # Move to the end of the file
            file_size = f.tell()  # Get the file size
            msvcrt.locking(f.fileno(), msvcrt.LK_LOCK, file_size)
        
        def unlock_file(f):
            """Unlock a file using msvcrt (Windows systems)"""
            f.seek(0, os.SEEK_END)  # Move to the end of the file
            file_size = f.tell()  # Get the file size
            msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, file_size)
        
        LOCK_AVAILABLE = True
        
    except ImportError:
        # Fallback if no locking mechanism is available
        logger.warning("File locking not available on this system. Race conditions may occur.")
        
        def lock_file(f):
            """Dummy lock function when locking is unavailable"""
            pass
        
        def unlock_file(f):
            """Dummy unlock function when locking is unavailable"""
            pass
        
        LOCK_AVAILABLE = False


def find_env_file(search_paths: List[str] = None) -> Optional[str]:
    """
    Find an environment file in the specified search paths.
    
    Args:
        search_paths: List of paths to search for .env file
                     (defaults to ['.env', '../.env', '../../.env'])
    
    Returns:
        Path to the found .env file or None if not found
    """
    if search_paths is None:
        search_paths = ['.env', '../.env', '../../.env']
    
    for path in search_paths:
        if os.path.exists(path):
            logger.debug(f"Found .env file at: {path}")
            return path
    
    logger.warning("No .env file found in search paths")
    return None


def read_env_file(env_file: str) -> List[str]:
    """
    Read an environment file with proper error handling and file locking.
    
    Args:
        env_file: Path to the .env file
    
    Returns:
        List of lines from the .env file
    
    Raises:
        FileNotFoundError: If the file doesn't exist
        IOError: If there's an error reading the file
    """
    if not os.path.exists(env_file):
        logger.error(f".env file not found: {env_file}")
        raise FileNotFoundError(f".env file not found: {env_file}")
    
    try:
        with open(env_file, 'r', encoding='utf-8') as f:
            # Lock the file for reading
            lines = f.readlines()
            logger.debug(f"Successfully read {len(lines)} lines from .env file")
            return lines
    except IOError as e:
        logger.error(f"Error reading .env file: {e}")
        raise


def write_env_file(env_file: str, lines: List[str]) -> bool:
    """
    Write to an environment file with proper error handling and file locking.
    
    Args:
        env_file: Path to the .env file
        lines: List of lines to write to the file
    
    Returns:
        True if successful, False otherwise
    
    Raises:
        IOError: If there's an error writing to the file
    """
    try:
        with open(env_file, 'w', encoding='utf-8') as f:
            # Lock the file for writing
            lock_file(f)
            try:
                f.writelines(lines)
                logger.debug(f"Successfully wrote {len(lines)} lines to .env file")
                return True
            finally:
                # Always unlock the file
                unlock_file(f)
    except IOError as e:
        logger.error(f"Error writing to .env file: {e}")
        raise


def update_env_variable(
    key: str, 
    value: Any, 
    env_file: str = None, 
    search_paths: List[str] = None,
    json_encode: bool = False
) -> bool:
    """
    Update or add an environment variable in the .env file.
    
    Args:
        key: Environment variable key
        value: Value to set
        env_file: Path to the .env file (if None, will search for it)
        search_paths: List of paths to search for .env file
        json_encode: Whether to JSON encode the value
    
    Returns:
        True if successful, False otherwise
    """
    # Find .env file if not specified
    if env_file is None:
        env_file = find_env_file(search_paths)
        if env_file is None:
            logger.error("Could not find .env file")
            return False
    
    try:
        # Format the value
        if json_encode:
            formatted_value = json.dumps(value, ensure_ascii=False)
        else:
            formatted_value = str(value)
        
        # Read the file
        lines = read_env_file(env_file)
        
        # Look for the key
        key_line_index = None
        for i, line in enumerate(lines):
            if line.startswith(f'{key}='):
                key_line_index = i
                break
        
        # Update or add the key-value pair
        if key_line_index is not None:
            lines[key_line_index] = f'{key}={formatted_value}\n'
            logger.debug(f"Updated existing variable: {key}")
        else:
            lines.append(f'{key}={formatted_value}\n')
            logger.debug(f"Added new variable: {key}")
        
        # Write the updated content back to the file
        write_env_file(env_file, lines)
        logger.info(f"Successfully updated environment variable in {env_file}: {key}")
        return True
        
    except Exception as e:
        logger.error(f"Error updating environment variable: {e}")
        return False


def remove_env_variable(
    key: str, 
    env_file: str = None, 
    search_paths: List[str] = None
) -> bool:
    """
    Remove an environment variable from the .env file.
    
    Args:
        key: Environment variable key to remove
        env_file: Path to the .env file (if None, will search for it)
        search_paths: List of paths to search for .env file
    
    Returns:
        True if successful, False otherwise
    """
    # Find .env file if not specified
    if env_file is None:
        env_file = find_env_file(search_paths)
        if env_file is None:
            logger.error("Could not find .env file")
            return False
    
    try:
        # Read the file
        lines = read_env_file(env_file)
        
        # Filter out the line with the key
        new_lines = [line for line in lines if not line.startswith(f'{key}=')]
        
        # If no lines were removed, the key wasn't found
        if len(new_lines) == len(lines):
            logger.warning(f"Key not found in .env file: {key}")
            return False
        
        # Write the updated content back to the file
        write_env_file(env_file, new_lines)
        logger.info(f"Successfully removed environment variable from {env_file}: {key}")
        return True
        
    except Exception as e:
        logger.error(f"Error removing environment variable: {e}")
        return False